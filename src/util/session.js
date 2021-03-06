/*
 * Copyright 2012 Denis Washington <denisw@online.de>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// session.js:
// Handles session management.

var xmpp = require('node-xmpp');
var http = require('http');
var xml = require('libxmljs');
var iso8601 = require('iso8601');
var jwt = require('jwt-simple');
var api = require('./api');
var cache = require('./cache');
var config = require('./config');
var pubsub = require('./pubsub');
var atom = require('./atom');

var anonymousSession;
var sessionCache = new cache.Cache(config.sessionExpirationTime);
sessionCache.onexpired = function(_, session) {
  session.end();
};

/**
 * Middleware that sets req.session to a Session object matching the
 * request's supplied session ID or it's authentication credentials.
 * It is assumed to run afer auth.parser().
 */
exports.provider = function(req, res, next) {
  var sessionId = req.header('X-Session-Id');
  if (sessionId) {
    processSessionId(sessionId, req, res, next);
  } else if (req.user) {
    createSession(req, res, next);
  } else {
    useAnonymousSession(req, res, next);
  }
};

function processSessionId(sessionId, req, res, next) {
  var session = sessionCache.get(sessionId);
  if (session) {
    provideSession(session, req, res, next);
  } else if (req.user) {
    createSession(req, res, next);
  } else {
    api.sendUnauthorized(res);
  }
}

function provideSession(session, req, res, next) {
  req.session = session;
  if (session.id) {
    sessionCache.put(session.id, session);
    res.header('X-Session-Id', session.id);
  }
  next();
}

function createSession(req, res, next) {
  var options = xmppConnectionOptions(req);
  var client = new xmpp.Client(options);
  var session;

  client.on('online', function() {
    var sessionId = req.user ? sessionCache.generateKey() : null;
    session = new Session(sessionId, client);
    provideSession(session, req, res, next);
  });

  client.on('error', function(err) {
    // FIXME: Checking the error type bassed on the error message
    // is fragile, but this is the only information that node-xmpp
    // gives us.
    if (err == 'XMPP authentication failure') {
      api.sendUnauthorized(res);
    } else {
      next(err);
    }
  });
}

function xmppConnectionOptions(req) {
  if (req.user) {
    return {
      jid: req.user,
      password: req.password,
      host: config.xmppHost,
      port: config.xmppPort
    };
  } else {
    var domain = config.xmppAnonymousDomain || config.xmppDomain;
    var host = config.xmppAnonymousHost || config.xmppHost;
    var port = config.xmppAnonymousPort ||config.xmppPort;
    return {
      jid: '@' + domain,
      host: host,
      port: port
    };
  }
}

function useAnonymousSession(req, res, next) {
  if (anonymousSession) {
    provideSession(anonymousSession, req, res, next);
  } else {
    createSession(req, res, function(err) {
      if (!err)
        anonymousSession = req.session;
      next(err);
    });
  }
}


function Session(id, connection) {
  this.id = id;
  this.jid = connection.jid.toString();
  this._connection = connection;
  this._replyHandlers = new cache.Cache(config.requestExpirationTime);
  this._subs = new cache.Cache(config.sessionExpirationTime);
  this._subsPresences = {}; // refcounts
  this._setupExpirationHandler();
  this._setupStanzaListener();
}

Session.prototype._setupExpirationHandler = function() {
  this._replyHandlers.onexpired = function(_, handler) {
    var error = new xmpp.Iq({'type': 'error'}).
      c('error', {'type': 'cancel'}).
      c('service-unavailable').
      root();
    handler(error);
  };

  // TODO: send iq to unsub. also decrement refs on presence, and send pres
  //   unavailable if needed.
  /*this._subs.onexpired = function(_, handler) {
    var error = new xmpp.Iq({'type': 'error'}).
      c('error', {'type': 'cancel'}).
      c('service-unavailable').
      root();
    handler(error);
  };*/
};

function makeChannelName(s) {
  return s.replace(/\//g, ".");
}

Session.prototype._setupStanzaListener = function() {
  var self = this;
  this._connection.on('stanza', function(stanza) {
    console.log("IN xmpp: " + stanza);
    if (stanza.name == "message") {
      var messagedoc = xml.parseXmlString(stanza.toString());
      var items = messagedoc.get('/message/p:event/p:items', {
        p: pubsub.ns + '#event',
      });
      if (items) {
        var entries = messagedoc.find('/message/p:event/p:items/p:item/a:entry', {
          p: pubsub.ns + '#event',
          a: atom.ns
        });
        var nodeId = items.attr('node').value();
        console.log("got items for node " + nodeId);
        for(var i = 0; i < entries.length; ++i) {
          console.log(" " + entries[i].toString());
        }
        var pubjid = config.channelDomain;
        var subkey = pubjid + "_" + nodeId;
        var sub = self._subs[subkey];
        if (sub) {
          sub = sub.userData;
          if (sub.items === undefined) {
            sub.items = [];
            sub.from = stanza.attr('from');
            sub.prevId = null;
            sub.lastPublishedId = null;
          }
          for(var i = 0; i < entries.length; ++i) {
            var entry = entries[i];
            var item = {};
            item.id = {};
            item.id.id = entry.get('a:id', { a: atom.ns }).text();
            var timestr = entry.get('a:updated', { a: atom.ns }).text();
            item.id.time = Math.floor(iso8601.toDate(timestr).getTime() / 1000) * 1000;
            item.entry = entries[i];
            sub.items.push(item);
          }

          if (config.fanoutRealm) {
            // publish using id of latest item, and prev id of last recorded
            var item = sub.items[sub.items.length - 1];
            var foId = item.id.id + '_' + item.id.time;
            var foPrevId = null;
            if (sub.lastPublishedId) {
              foPrevId = sub.lastPublishedId;
            }
            sub.lastPublishedId = foId;

            var at = nodeId.indexOf('/user/');
            var channelAndNode = nodeId.substring(at + 6);
            at = channelAndNode.indexOf('/');
            var channel = channelAndNode.substring(0, at);
            var node = channelAndNode.substring(at + 1);

            var feed = api.generateNodeFeedFromEntries(channel, node, sub.from, entries);

            var foChannel = makeChannelName(self.jid + '_' + nodeId);

            var headers = {};
            headers['Content-Type'] = 'application/atom+xml';
            var hritem = {};
            hritem['headers'] = headers;
            hritem['body'] = feed.root().toString();

            self.fanoutPublish(foChannel + '-atom', foId, foPrevId, hritem);

            headers = {};
            headers['Content-Type'] = 'application/json';
            var hritem = {};
            hritem['headers'] = headers;
            hritem['body'] = JSON.stringify(atom.toJSON(feed.root()));

            self.fanoutPublish(foChannel + '-json', foId, foPrevId, hritem);
          }
        }
      }
    }
    if (stanza.attrs.id) {
      var handler = self._replyHandlers.get(stanza.attrs.id);
      if (handler) {
        self._replyHandlers.remove(stanza.attrs.id);
        handler(stanza);
      }
    }
  });
};

/**
 * Registers a handler for incoming stanzas. Whenever the session receives
 * a stanza which is not a reply to a stanza sent with sendQuery(), the
 * callback is called with the stanza as argument.
 */
Session.prototype.onStanza = function(handler) {
  var callback = function(stanza) {
    if (handler(stanza)) {
      this._connection.removeListener(callback);
    }
  };
  this._connection.on('stanza', callback);
};

/**
 * Sends a query to the XMPP server using the session's connection. When a
 * reply is received, 'onreply' is called with the reply stanza as argument.
 */
Session.prototype.sendQuery = function(iq, onreply) {
  var queryId = this._replyHandlers.generateKey();
  this._replyHandlers.put(queryId, onreply);

  iq = iq.root();
  iq.attr('from', this._connection.jid.toString());
  iq.attr('to', config.channelDomain);
  iq.attr('id', queryId);
  console.log("OUT xmpp: " + iq);
  this._connection.send(iq);
};

/**
 * Sends a reply for a received <iq/>.
 */
Session.prototype.replyToQuery = function(iq) {
  var reply = new xmpp.Iq({
    type: 'result',
    from: iq.attrs.to,
    to: iq.attrs.from,
    id: iq.attrs.id
  });
  this._connection.send(reply);
};

/**
 * Closes the XMPP connection associated with the session.
 */
Session.prototype.end = function() {
  this._connection.end();
};

/**
 * Create temporary subscription. 'onsub' is called with a state object as
 * argument. If the subscription cannot be created, then 'onerror' is called
 * with an error string. Calling subscribe() after a subscription already
 * exists will cause the timeout to be extended and 'onsub' called
 * immediately.
 */
Session.prototype.subscribe = function(nodeId, onsub, onerror) {
  var pubjid = config.channelDomain;
  var subkey = pubjid + "_" + nodeId;
  var sub = this._subs[subkey];
  if (sub) {
    if (sub.state === 'subscribed') {
      onsub(sub.userData);
    } else if (sub.state === 'subscribing') {
      var p = {};
      p.onsub = onsub;
      p.onerror = onerror;
      sub.pending.push(p);
    } else {
      onerror('an error that should not happen');
    }
    return;
  }

  var p = {};
  p.onsub = onsub;
  p.onerror = onerror;
  sub = { state: 'subscribing', pending: [p], userData: {} };
  this._subs[subkey] = sub;

  var refs = this._subsPresences[pubjid];
  if (!refs) {
    refs = 1;
    this._subsPresences[pubjid] = refs;
    var pres = new xmpp.Presence({
      from: this.jid,
      to: pubjid,
    });
    console.log("OUT xmpp: " + pres);
    this._connection.send(pres);
  }
  else {
    ++refs;
  }

  var iq = pubsub.subscribeIq(nodeId, this.jid, true);
  var self = this;
  this.sendQuery(iq, function(reply) {
    if (reply.type == "result") {
      sub.state = 'subscribed';
      // TODO: record subid, needed for unsub
      for(var i = 0; i < sub.pending.length; ++i) {
        sub.pending[i].onsub(sub.userData);
      }
    }
    else {
      var pending = sub.pending;
      delete self._subs[subkey];
      for(var i = 0; i < pending.length; ++i) {
        pending[i].onerror('failed');
      }
    }
  });
}

Session.prototype.fanoutPublish = function(channel, id, prevId, hrItem) {
  var item = {};
  if (id) {
    item['id'] = id;
  }
  if (prevId) {
    item['prev-id'] = prevId;
  }
  item['http-response'] = hrItem;
  var items = [];
  items.push(item);
  var content = {};
  content["items"] = items;
  var contentRaw = JSON.stringify(content);

  var claim = {};
  claim["exp"] = Math.floor((new Date()).getTime() / 1000) + 3600;
  claim["iss"] = config.fanoutRealm;
  var authToken = jwt.encode(claim, new Buffer(config.fanoutKey, 'base64'));
  console.log("token: " + authToken);

  var options = {
    'method': 'POST',
    'hostname': 'api.fanout.io',
    'path': '/realm/' + config.fanoutRealm + '/publish/' + channel + '/',
    'headers': {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(contentRaw, 'utf8'),
      'Authorization': 'Bearer ' + authToken,
    }
  };

  console.log(options.path);

  var req = http.request(options, function(res) {
    console.log("STATUS: " + res.statusCode);
    res.on("data", function(chunk) {
      console.log("BODY: " + chunk);
    });
  });
  req.write(contentRaw);
  req.end();
}
