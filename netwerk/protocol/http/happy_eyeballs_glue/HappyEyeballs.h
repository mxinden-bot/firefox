/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef HappyEyeballs_h_
#define HappyEyeballs_h_

#include <cstdint>
#include "nsError.h"
#include "nsTArray.h"
#include "mozilla/StaticPrefs_network.h"
#include "nsHttpHandler.h"
#include "mozilla/net/happy_eyeballs_glue.h"

namespace mozilla {
namespace net {

class HappyEyeballs final {
 public:
  static nsresult Init(HappyEyeballs** aHappyEyeballs,
                       const nsACString& aOrigin, uint16_t aPort,
                       const nsTArray<happy_eyeballs::AltSvc>* aAltSvc,
                       happy_eyeballs::IpPreference aPref,
                       uint32_t aResolutionDelayMs,
                       uint32_t aConnectionAttemptDelayMs) {
    // Restrict the protocols the Happy Eyeballs engine may attempt to those
    // enabled by prefs (network.http.http2.enabled, and
    // network.http.http3.enable via nsHttpHandler::IsHttp3Enabled()). With
    // these set, the state machine itself refuses to emit HTTP/3 (or HTTP/2)
    // connection attempts derived from HTTPS records, IP hints, or alt-svc,
    // so disabled protocols never reach the wire.
    happy_eyeballs::HttpVersions httpVersions{
        /* h1 */ true,
        /* h2 */ StaticPrefs::network_http_http2_enabled(),
        /* h3 */ nsHttpHandler::IsHttp3Enabled(),
    };
    return happy_eyeballs::happy_eyeballs_create(
        (const HappyEyeballs**)aHappyEyeballs, &aOrigin, aPort, aAltSvc, aPref,
        httpVersions, aResolutionDelayMs, aConnectionAttemptDelayMs);
  }

  void AddRef() { happy_eyeballs::happy_eyeballs_addref(this); }
  void Release() { happy_eyeballs::happy_eyeballs_release(this); }

 private:
  HappyEyeballs() = delete;
  ~HappyEyeballs() = delete;
};

}  // namespace net
}  // namespace mozilla

#endif
