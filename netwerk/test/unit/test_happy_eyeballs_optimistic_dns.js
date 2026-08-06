/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// Optimistic DNS: an address served from a stale (past-TTL, grace-period) cache
// entry is raced immediately, and Happy Eyeballs revalidates it with a fresh,
// cache-bypassing lookup. Here the stale address fails to connect, the
// revalidation returns a working address, and the connection succeeds on it.

var { setTimeout } = ChromeUtils.importESModule(
  "resource://gre/modules/Timer.sys.mjs"
);

const { NodeHTTP2Server } = ChromeUtils.importESModule(
  "resource://testing-common/NodeServer.sys.mjs"
);

const override = Cc["@mozilla.org/network/native-dns-override;1"].getService(
  Ci.nsINativeDNSResolverOverride
);

const mockController = Cc[
  "@mozilla.org/network/mock-network-controller;1"
].getService(Ci.nsIMockNetworkLayerController);

let certdb = Cc["@mozilla.org/security/x509certdb;1"].getService(
  Ci.nsIX509CertDB
);
addCertFromFile(certdb, "http2-ca.pem", "CTu,u,u");

add_setup(function () {
  // TEMPORARY diagnostic logging to understand how the no-fix build reaches the
  // fresh address (resolver stale-refresh vs channel restart). Remove before landing.
  Services.prefs.setIntPref("logging.nsHostResolver", 5);
  Services.prefs.setIntPref("logging.nsHttp", 5);
  Services.prefs.setBoolPref("network.http.happy_eyeballs_enabled", true);
  Services.prefs.setBoolPref("network.socket.attach_mock_network_layer", true);
  // Keep the flow to a single (IPv4) family so the stale address and its
  // revalidation are unambiguous.
  Services.prefs.setBoolPref("network.dns.disableIPv6", true);
  // Short TTL so a seeded entry becomes stale after a brief wait; the default
  // grace period (600s) keeps it usable in the meantime.
  Services.prefs.setIntPref("network.dnsCacheExpiration", 1);
  registerCleanupFunction(() => {
    Services.prefs.clearUserPref("network.http.happy_eyeballs_enabled");
    Services.prefs.clearUserPref("network.socket.attach_mock_network_layer");
    Services.prefs.clearUserPref("network.dns.disableIPv6");
    Services.prefs.clearUserPref("network.dnsCacheExpiration");
    override.clearOverrides();
    mockController.clearBlockedTCPConnect();
  });
});

async function openChan(uri) {
  let chan = NetUtil.newChannel({
    uri,
    loadUsingSystemPrincipal: true,
  }).QueryInterface(Ci.nsIHttpChannel);
  chan.loadFlags = Ci.nsIChannel.LOAD_INITIAL_DOCUMENT_URI;

  let result = await new Promise(resolve => {
    chan.asyncOpen(
      new ChannelListener(
        (r, b) => resolve({ req: r, buffer: b }),
        null,
        CL_ALLOW_UNKNOWN_CL
      )
    );
  });

  return {
    addr: result.req.QueryInterface(Ci.nsIHttpChannelInternal).remoteAddress,
    httpVersion: result.req.protocolVersion,
    status: result.req.QueryInterface(Ci.nsIHttpChannel).responseStatus,
    buffer: result.buffer,
  };
}

add_task(async function test_stale_answer_revalidated_and_succeeds() {
  const host = "foo.example.com";
  // The stale answer, which is blocked and never connects.
  const staleAddr = "127.0.0.2";
  // The revalidation answer, backed by the real server.
  const freshAddr = "127.0.0.1";

  let server = new NodeHTTP2Server();
  await server.start();
  await server.registerPathHandler("/test", (_req, resp) => {
    resp.writeHead(200, { "Content-Type": "text/plain" });
    resp.end("ok");
  });
  const port = server.port();

  // The stale address never accepts a connection.
  mockController.blockTCPConnect(
    mockController.createScriptableNetAddr(staleAddr, port)
  );

  // Seed the DNS cache with the stale address by driving one connection through
  // the Happy Eyeballs path, so the entry is keyed exactly as the real request
  // below and is later served stale to it. The connection to the blocked
  // address is refused, but the A record is cached with the 1s TTL set above.
  override.addIPOverride(host, staleAddr);
  let seed = NetUtil.newChannel({
    uri: `https://${host}:${port}/test`,
    loadUsingSystemPrincipal: true,
  }).QueryInterface(Ci.nsIHttpChannel);
  seed.loadFlags = Ci.nsIChannel.LOAD_INITIAL_DOCUMENT_URI;
  await new Promise(resolve => {
    seed.asyncOpen(
      new ChannelListener(() => resolve(), null, CL_EXPECT_FAILURE)
    );
  });
  Assert.equal(
    seed.status,
    Cr.NS_ERROR_CONNECTION_REFUSED,
    "Seeding connection to the stale address should be refused"
  );

  // Let the cached entry age past its TTL so the next lookup serves it stale
  // (from the grace period).
  // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
  await new Promise(resolve => setTimeout(resolve, 1100));

  // From now on the host resolves to the working address, so the revalidation
  // (a cache-bypassing lookup) picks it up.
  override.clearHostOverride(host);
  override.addIPOverride(host, freshAddr);

  info("DIAG-MARKER: opening main channel now");
  // The stale address is raced first and its connection is refused; Optimistic
  // DNS revalidates and races the fresh address, which succeeds.
  let { status, httpVersion, buffer, addr } = await openChan(
    `https://${host}:${port}/test`
  );
  info("DIAG-MARKER: main channel done, remoteAddress=" + addr);

  Assert.equal(status, 200, "Request should succeed");
  Assert.equal(buffer, "ok", "Response body should match");
  Assert.equal(httpVersion, "h2", "Should use HTTP/2");
  Assert.equal(
    addr,
    freshAddr,
    "Should connect to the revalidated address, not the stale one"
  );

  await server.stop();
});
