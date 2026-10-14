/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// A LOAD_FRESH_CONNECTION | LOAD_INITIAL_DOCUMENT_URI load must only clear
// the Alt-Svc mappings that share its origin attributes.

const { NodeHTTP2Server } = ChromeUtils.importESModule(
  "resource://testing-common/NodeServer.sys.mjs"
);

add_task(async function test_fresh_connection_clears_only_own_oa_altsvc() {
  do_get_profile();
  Services.prefs.setCharPref("network.dns.localDomains", "foo.example.com");
  let certdb = Cc["@mozilla.org/security/x509certdb;1"].getService(
    Ci.nsIX509CertDB
  );
  addCertFromFile(certdb, "http2-ca.pem", "CTu,u,u");

  let server = new NodeHTTP2Server();
  await server.start();
  await server.registerPathHandler("/", (req, resp) => {
    resp.writeHead(200);
    resp.end("ok");
  });

  // Every channel to the origin adds an already validated mapping for its
  // origin attributes.
  Services.prefs.setCharPref(
    "network.http.http3.alt-svc-mapping-for-testing",
    `foo.example.com;h2=:${server.port()}`
  );
  registerCleanupFunction(async () => {
    Services.prefs.clearUserPref("network.dns.localDomains");
    Services.prefs.clearUserPref(
      "network.http.http3.alt-svc-mapping-for-testing"
    );
    await server.stop();
  });

  async function load(originAttributes, loadFlags = 0) {
    let chan = NetUtil.newChannel({
      uri: `https://foo.example.com:${server.port()}/`,
      loadUsingSystemPrincipal: true,
    });
    chan.loadInfo.originAttributes = originAttributes;
    chan.loadFlags = loadFlags;
    await new Promise(resolve =>
      chan.asyncOpen(new ChannelListener(resolve, null, CL_ALLOW_UNKNOWN_CL))
    );
  }

  let hasMapping = userContextId =>
    Services.io
      .getProtocolHandler("http")
      .QueryInterface(Ci.nsIHttpProtocolHandler)
      .altSvcCacheKeys.some(key =>
        key.includes(`^userContextId=${userContextId}:`)
      );

  // The Alt-Svc storage is only initialized by the first load's lookup.
  await load({});
  await load({ userContextId: 1 });
  await load({ userContextId: 2 });
  Assert.ok(hasMapping(1) && hasMapping(2), "Both OAs have a mapping");

  // The testing pref re-adds the mapping in BeginConnect before the
  // shift-reload clear runs, so it must be gone afterwards.
  await load(
    { userContextId: 2 },
    Ci.nsIRequest.LOAD_FRESH_CONNECTION |
      Ci.nsIChannel.LOAD_INITIAL_DOCUMENT_URI
  );
  Assert.ok(!hasMapping(2), "Fresh load cleared the mapping of its own OA");
  Assert.ok(hasMapping(1), "Fresh load kept the mapping of the other OA");
});
