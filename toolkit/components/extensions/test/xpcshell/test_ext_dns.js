"use strict";

const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);

const gDashboard = Cc["@mozilla.org/network/dashboard;1"].getService(
  Ci.nsIDashboard
);

// Some test machines and android are not returning ipv6, turn it
// off to get consistent test results.
Services.prefs.setBoolPref("network.dns.disableIPv6", true);

AddonTestUtils.init(this);
AddonTestUtils.overrideCertDB();

AddonTestUtils.createAppInfo(
  "xpcshell@tests.mozilla.org",
  "XPCShell",
  "1",
  "42"
);

function getExtension() {
  let manifest = {
    permissions: ["dns", "proxy"],
  };
  return ExtensionTestUtils.loadExtension({
    manifest,
    background() {
      browser.test.onMessage.addListener(async (msg, data) => {
        if (msg == "proxy") {
          await browser.proxy.settings.set({ value: data });
          browser.test.sendMessage("proxied");
          return;
        }
        browser.test.log(`=== dns resolve test ${JSON.stringify(data)}`);
        browser.dns
          .resolve(data.hostname, data.flags)
          .then(result => {
            browser.test.log(
              `=== dns resolve result ${JSON.stringify(result)}`
            );
            browser.test.sendMessage("resolved", result);
          })
          .catch(e => {
            browser.test.log(`=== dns resolve error ${e.message}`);
            browser.test.sendMessage("resolved", { message: e.message });
          });
      });
      browser.test.sendMessage("ready");
    },
    incognitoOverride: "spanning",
    useAddonManager: "temporary",
  });
}

const tests = [
  {
    request: {
      hostname: "localhost",
    },
    expect: {
      addresses: ["127.0.0.1"], // ipv6 disabled , "::1"
    },
  },
  {
    request: {
      hostname: "localhost",
      flags: ["offline"],
    },
    expect: {
      addresses: ["127.0.0.1"], // ipv6 disabled , "::1"
    },
  },
  {
    request: {
      hostname: "test.example",
    },
    expect: {
      // android will error with offline
      error: /NS_ERROR_UNKNOWN_HOST|NS_ERROR_OFFLINE/,
    },
  },
  {
    request: {
      hostname: "127.0.0.1",
      flags: ["canonical_name"],
    },
    expect: {
      canonicalName: "127.0.0.1",
      addresses: ["127.0.0.1"],
    },
  },
  {
    request: {
      hostname: "localhost",
      flags: ["disable_ipv6"],
    },
    expect: {
      addresses: ["127.0.0.1"],
    },
  },
];

add_setup(async function startup() {
  await AddonTestUtils.promiseStartupManager();
});

add_task(async function test_dns_resolve() {
  let extension = getExtension();
  await extension.startup();
  await extension.awaitMessage("ready");

  for (let test of tests) {
    extension.sendMessage("resolve", test.request);
    let result = await extension.awaitMessage("resolved");
    if (test.expect.error) {
      ok(
        test.expect.error.test(result.message),
        `expected error ${result.message}`
      );
    } else {
      equal(
        result.canonicalName,
        test.expect.canonicalName,
        "canonicalName match"
      );
      // It seems there are platform differences happening that make this
      // testing difficult. We're going to rely on other existing dns tests to validate
      // the dns service itself works and only validate that we're getting generally
      // expected results in the webext api.
      Assert.greaterOrEqual(
        result.addresses.length,
        test.expect.addresses.length,
        "expected number of addresses returned"
      );
      if (test.expect.addresses.length && result.addresses.length) {
        ok(
          result.addresses.includes(test.expect.addresses[0]),
          "got expected ip address"
        );
      }
    }
  }

  await extension.unload();
});

function isHTTPSRecordCached(hostname) {
  return new Promise(resolve => {
    gDashboard.requestDNSInfo(function (data) {
      resolve(
        data.entries.some(
          entry =>
            entry.hostname == hostname &&
            entry.type == Ci.nsIDNSService.RESOLVE_TYPE_HTTPSSVC
        )
      );
    });
  });
}

// When an extension resolves a hostname (e.g. for CNAME uncloaking) it only
// receives A/AAAA, but we also warm the HTTPS RR cache so that a subsequent
// connection does not race a warm address against a cold HTTPS record and miss
// HTTP/3 (bug 1953459). This must happen even with network.dns.disablePrefetch
// set, which is the configuration the warming is meant to repair.
add_task(async function test_dns_resolve_warms_https_rr() {
  Services.dns.clearCache(false);
  Services.prefs.setBoolPref("network.dns.native_https_query", true);
  Services.prefs.setBoolPref("network.dns.native_https_query_win10", true);
  Services.prefs.setBoolPref("network.dns.upgrade_with_https_rr", true);
  Services.prefs.setBoolPref("network.dns.use_https_rr_as_altsvc", true);
  Services.prefs.setBoolPref("network.dns.disablePrefetch", true);

  const override = Cc["@mozilla.org/network/native-dns-override;1"].getService(
    Ci.nsINativeDNSResolverOverride
  );
  // Encodes an HTTPS RR for service.com with alpn=["h2","h3"].
  let rawBuffer = [
    0, 0, 128, 0, 0, 0, 0, 1, 0, 0, 0, 0, 7, 115, 101, 114, 118, 105, 99, 101,
    3, 99, 111, 109, 0, 0, 65, 0, 1, 0, 0, 0, 55, 0, 13, 0, 1, 0, 0, 1, 0, 6, 2,
    104, 50, 2, 104, 51,
  ];
  override.addHTTPSRecordOverride("service.com", rawBuffer, rawBuffer.length);
  override.addIPOverride("service.com", "127.0.0.1");

  registerCleanupFunction(() => {
    Services.prefs.clearUserPref("network.dns.native_https_query");
    Services.prefs.clearUserPref("network.dns.native_https_query_win10");
    Services.prefs.clearUserPref("network.dns.upgrade_with_https_rr");
    Services.prefs.clearUserPref("network.dns.use_https_rr_as_altsvc");
    Services.prefs.clearUserPref("network.dns.disablePrefetch");
    override.clearOverrides();
  });

  let extension = getExtension();
  await extension.startup();
  await extension.awaitMessage("ready");

  extension.sendMessage("resolve", { hostname: "service.com" });
  let result = await extension.awaitMessage("resolved");
  ok(
    result.addresses.includes("127.0.0.1"),
    "extension still receives the address record"
  );

  // The HTTPS RR query is fire-and-forget, so wait for it to populate the cache.
  await TestUtils.waitForCondition(
    () => isHTTPSRecordCached("service.com"),
    "HTTPS RR should be resolved alongside the address lookup"
  );

  await extension.unload();
});

add_task(async function test_dns_resolve_socks() {
  let extension = getExtension();
  await extension.startup();
  await extension.awaitMessage("ready");
  extension.sendMessage("proxy", {
    proxyType: "manual",
    socks: "127.0.0.1",
    socksVersion: 5,
    proxyDNS: true,
  });
  await extension.awaitMessage("proxied");
  equal(
    Services.prefs.getIntPref("network.proxy.type"),
    1 /* PROXYCONFIG_MANUAL */,
    "manual proxy"
  );
  equal(
    Services.prefs.getStringPref("network.proxy.socks"),
    "127.0.0.1",
    "socks proxy"
  );
  ok(
    Services.prefs.getBoolPref("network.proxy.socks_remote_dns"),
    "socks4 remote dns"
  );
  ok(
    Services.prefs.getBoolPref("network.proxy.socks5_remote_dns"),
    "socks5 remote dns"
  );
  extension.sendMessage("resolve", {
    hostname: "mozilla.org",
  });
  let result = await extension.awaitMessage("resolved");
  ok(
    /NS_ERROR_UNKNOWN_PROXY_HOST/.test(result.message),
    `expected error ${result.message}`
  );
  await extension.unload();
});
