/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * This test checks nsIHttpChannelInternal.proxyConnectionVersion, which
 * reports the ALPN token negotiated on the browser->proxy hop, as distinct
 * from nsIHttpChannel.protocolVersion which reports the end-to-end (origin)
 * protocol carried through the tunnel.
 *
 * Cases covered:
 *  - No proxy: proxyConnectionVersion is "" (empty).
 *  - HTTPS (HTTP/2) CONNECT proxy with an HTTPS origin: proxyConnectionVersion
 *    is "h2". This is the EndToEndSSL case, where the channel's mSecurityInfo
 *    describes the origin TLS rather than the proxy TLS, so the value can only
 *    come from the transaction (nsHttpTransaction::SetConnection).
 */

/* global serverPort */

"use strict";

// We don't normally allow localhost channels to be proxied, but this
// is easier than updating all the certs and/or domains.
Services.prefs.setBoolPref("network.proxy.allow_hijacking_localhost", true);
registerCleanupFunction(() => {
  Services.prefs.clearUserPref("network.proxy.allow_hijacking_localhost");
});

const pps = Cc["@mozilla.org/network/protocol-proxy-service;1"].getService();
const { NodeServer } = ChromeUtils.importESModule(
  "resource://testing-common/NodeServer.sys.mjs"
);

let proxy_port;
let filter;

class ProxyFilter {
  constructor(type, host, port, flags) {
    this._type = type;
    this._host = host;
    this._port = port;
    this._flags = flags;
    this.QueryInterface = ChromeUtils.generateQI(["nsIProtocolProxyFilter"]);
  }
  applyFilter(uri, pi, cb) {
    cb.onProxyFilterResult(
      pps.newProxyInfo(
        this._type,
        this._host,
        this._port,
        "",
        "",
        this._flags,
        1000,
        null
      )
    );
  }
}

function createPrincipal(url) {
  var ssm = Services.scriptSecurityManager;
  try {
    return ssm.createContentPrincipal(Services.io.newURI(url), {});
  } catch (e) {
    return null;
  }
}

function make_channel(url) {
  return NetUtil.newChannel({
    uri: url,
    loadingPrincipal: createPrincipal(url),
    securityFlags: Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_INHERITS_SEC_CONTEXT,
    contentPolicyType: Ci.nsIContentPolicy.TYPE_DOCUMENT,
  });
}

// Resolves with the channel's end-to-end and proxy-leg protocol versions
// together with the request status.
function get_versions(channel, flags = CL_ALLOW_UNKNOWN_CL) {
  return new Promise(resolve => {
    channel.asyncOpen(
      new ChannelListener((request, data) => {
        request.QueryInterface(Ci.nsIHttpChannel);
        const status = request.status;
        const protocolVersion = status ? undefined : request.protocolVersion;
        const internal = request.QueryInterface(Ci.nsIHttpChannelInternal);
        const proxyConnectionVersion = internal.proxyConnectionVersion;
        const isProxyUsed = internal.isProxyUsed;
        resolve({
          status,
          data,
          protocolVersion,
          proxyConnectionVersion,
          isProxyUsed,
        });
      }, null, flags)
    );
  });
}

// Minimal HTTP/2 CONNECT proxy reused from test_http2-proxy.js.
class http2ProxyCode {
  static listen(server) {
    if (!server) {
      return Promise.resolve(0);
    }
    return new Promise(resolve => {
      server.listen(0, "0.0.0.0", 2000, () => {
        resolve(server.address().port);
      });
    });
  }

  static startNewProxy() {
    const fs = require("fs");
    const options = {
      key: fs.readFileSync(__dirname + "/http2-cert.key"),
      cert: fs.readFileSync(__dirname + "/http2-cert.pem"),
    };
    const http2 = require("http2");
    global.proxy = http2.createSecureServer(options);
    this.setupProxy();
    return http2ProxyCode.listen(proxy).then(port => {
      return { port, success: true };
    });
  }

  static closeProxy() {
    proxy.closeSockets();
    return new Promise(resolve => {
      proxy.close(resolve);
    });
  }

  static setupProxy() {
    if (!proxy) {
      throw new Error("proxy is null");
    }
    proxy.socketIndex = 0;
    proxy.socketMap = {};
    proxy.on("connection", function (socket) {
      let index = proxy.socketIndex++;
      proxy.socketMap[index] = socket;
      socket.on("close", function () {
        delete proxy.socketMap[index];
      });
    });
    proxy.closeSockets = function () {
      for (let i in proxy.socketMap) {
        proxy.socketMap[i].destroy();
      }
    };

    proxy.on("stream", (stream, headers) => {
      if (headers[":method"] !== "CONNECT") {
        stream.respond({ ":status": 405 });
        stream.end();
        return;
      }
      const net = require("net");
      const socket = net.connect(serverPort, "127.0.0.1", () => {
        try {
          stream.respond({ ":status": 200 });
          socket.pipe(stream);
          stream.pipe(socket);
        } catch (exception) {
          stream.close();
        }
      });
      socket.on("error", error => {
        throw new Error(
          `Unexpected error connecting the HTTP/2 server from the proxy: '${error}'`
        );
      });
    });
  }
}

let processId;

add_task(async function setup() {
  do_get_profile();

  // The moz-http2 cert is for foo.example.com and is signed by http2-ca.pem
  // so add that cert to the trust list as a signing cert.
  let certdb = Cc["@mozilla.org/security/x509certdb;1"].getService(
    Ci.nsIX509CertDB
  );
  addCertFromFile(certdb, "http2-ca.pem", "CTu,u,u");

  let server_port = Services.env.get("MOZHTTP2_PORT");
  Assert.notEqual(server_port, null);

  Services.prefs.setBoolPref("network.http.http2.enabled", true);
  // make all native resolve calls "secretly" resolve localhost instead
  Services.prefs.setBoolPref("network.dns.native-is-localhost", true);

  processId = await NodeServer.fork();
  await NodeServer.execute(processId, `serverPort = ${server_port}`);
  await NodeServer.execute(processId, http2ProxyCode);
  let newProxy = await NodeServer.execute(
    processId,
    `http2ProxyCode.startNewProxy()`
  );
  proxy_port = newProxy.port;
  Assert.notEqual(proxy_port, null);
});

registerCleanupFunction(async () => {
  Services.prefs.clearUserPref("network.http.http2.enabled");
  Services.prefs.clearUserPref("network.dns.native-is-localhost");
  if (filter) {
    pps.unregisterFilter(filter);
  }
  await NodeServer.execute(processId, `http2ProxyCode.closeProxy()`);
  await NodeServer.kill(processId);
});

// Without a proxy, proxyConnectionVersion is empty even though the end-to-end
// protocol is HTTP/2.
add_task(async function no_proxy() {
  const res = await get_versions(
    make_channel(`https://foo.example.com/no-proxy-request`)
  );

  Assert.equal(res.status, Cr.NS_OK);
  Assert.equal(res.isProxyUsed, false, "no proxy in use");
  Assert.equal(res.protocolVersion, "h2", "origin negotiated h2");
  Assert.equal(
    res.proxyConnectionVersion,
    "",
    "no proxy hop, so proxyConnectionVersion is empty"
  );
});

// With an HTTPS (HTTP/2) CONNECT proxy and an HTTPS origin, the proxy leg
// reports "h2". This exercises the EndToEndSSL path that can only be answered
// from the transaction.
add_task(async function h2_proxy_https_origin() {
  filter = new ProxyFilter("https", "localhost", proxy_port, 0);
  pps.registerFilter(filter, 10);

  const res = await get_versions(
    make_channel(`https://foo.example.com/proxied-request`)
  );

  Assert.equal(res.status, Cr.NS_OK);
  Assert.equal(res.isProxyUsed, true, "proxy in use");
  Assert.equal(res.protocolVersion, "h2", "origin negotiated h2 in tunnel");
  Assert.equal(
    res.proxyConnectionVersion,
    "h2",
    "browser->proxy hop negotiated h2"
  );

  pps.unregisterFilter(filter);
  filter = null;
});
