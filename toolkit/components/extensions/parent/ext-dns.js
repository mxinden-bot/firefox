/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const dnssFlags = {
  allow_name_collisions: Ci.nsIDNSService.RESOLVE_ALLOW_NAME_COLLISION,
  bypass_cache: Ci.nsIDNSService.RESOLVE_BYPASS_CACHE,
  canonical_name: Ci.nsIDNSService.RESOLVE_CANONICAL_NAME,
  disable_ipv4: Ci.nsIDNSService.RESOLVE_DISABLE_IPV4,
  disable_ipv6: Ci.nsIDNSService.RESOLVE_DISABLE_IPV6,
  disable_trr: Ci.nsIDNSService.RESOLVE_DISABLE_TRR,
  offline: Ci.nsIDNSService.RESOLVE_OFFLINE,
  priority_low: Ci.nsIDNSService.RESOLVE_PRIORITY_LOW,
  priority_medium: Ci.nsIDNSService.RESOLVE_PRIORITY_MEDIUM,
  speculate: Ci.nsIDNSService.RESOLVE_SPECULATE,
};

function getErrorString(nsresult) {
  let e = new Components.Exception("", nsresult);
  return e.name;
}

this.dns = class extends ExtensionAPI {
  getAPI() {
    return {
      dns: {
        resolve: function (hostname, flags) {
          let dnsFlags = flags.reduce(
            (mask, flag) => mask | dnssFlags[flag],
            0
          );

          // Warm the HTTPS RR (HTTPSSVC) cache alongside the address lookup
          // the extension requested. Consumers such as CNAME uncloaking only
          // read A/AAAA, but resolving the addresses without also resolving
          // the HTTPS record leaves the latter cold. A later connection then
          // races a warm A/AAAA against a cold HTTPS RR and can miss HTTP/3
          // (bug 1953459). The result is intentionally discarded. This query
          // is deliberately not RESOLVE_SPECULATE: a speculative query is
          // dropped when network.dns.disablePrefetch is set (e.g. by uBlock
          // Origin's "disable pre-fetching", or a manual proxy), which is the
          // very configuration this warming repairs.
          if (
            Services.prefs.getBoolPref(
              "network.dns.upgrade_with_https_rr",
              false
            ) ||
            Services.prefs.getBoolPref(
              "network.dns.use_https_rr_as_altsvc",
              false
            )
          ) {
            try {
              Services.dns.asyncResolve(
                hostname,
                Ci.nsIDNSService.RESOLVE_TYPE_HTTPSSVC,
                dnsFlags,
                null, // AdditionalInfo
                { onLookupComplete() {} },
                null,
                {} /* defaultOriginAttributes */
              );
            } catch (e) {
              // Best-effort cache warming; ignore failures (e.g. IP literals).
            }
          }

          return new Promise((resolve, reject) => {
            let request;
            let response = {
              addresses: [],
            };
            let listener = {
              onLookupComplete: function (inRequest, inRecord, inStatus) {
                if (inRequest === request) {
                  if (!Components.isSuccessCode(inStatus)) {
                    return reject({ message: getErrorString(inStatus) });
                  }
                  inRecord.QueryInterface(Ci.nsIDNSAddrRecord);
                  if (dnsFlags & Ci.nsIDNSService.RESOLVE_CANONICAL_NAME) {
                    try {
                      response.canonicalName = inRecord.canonicalName;
                    } catch (e) {
                      // no canonicalName
                    }
                  }
                  response.isTRR = inRecord.IsTRR();
                  while (inRecord.hasMore()) {
                    let addr = inRecord.getNextAddrAsString();
                    // Sometimes there are duplicate records with the same ip.
                    if (!response.addresses.includes(addr)) {
                      response.addresses.push(addr);
                    }
                  }
                  return resolve(response);
                }
              },
            };
            try {
              request = Services.dns.asyncResolve(
                hostname,
                Ci.nsIDNSService.RESOLVE_TYPE_DEFAULT,
                dnsFlags,
                null, // AdditionalInfo
                listener,
                null,
                {} /* defaultOriginAttributes */
              );
            } catch (e) {
              // handle exceptions such as offline mode.
              return reject({ message: e.name });
            }
          });
        },
      },
    };
  }
};
