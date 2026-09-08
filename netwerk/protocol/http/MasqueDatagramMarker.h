/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_net_MasqueDatagramMarker_h
#define mozilla_net_MasqueDatagramMarker_h

#include "mozilla/ProfilerMarkers.h"

namespace geckoprofiler::markers {

// Datagrams crossing the connect-udp (MASQUE) tunnel. `queued` is the depth of
// the inbound queue; it is 0 for outbound markers, which hand the datagram
// straight to neqo.
struct MasqueDatagramMarker {
  static constexpr mozilla::Span<const char> MarkerTypeName() {
    return mozilla::MakeStringSpan("MasqueDatagram");
  }
  static void StreamJSONMarkerData(
      mozilla::baseprofiler::SpliceableJSONWriter& aWriter, uint32_t aSize,
      uint32_t aQueued) {
    aWriter.IntProperty("size", aSize);
    aWriter.IntProperty("queued", aQueued);
  }
  static mozilla::MarkerSchema MarkerTypeDisplay() {
    using MS = mozilla::MarkerSchema;
    MS schema{MS::Location::MarkerChart, MS::Location::MarkerTable};
    schema.SetTableLabel(
        "{marker.name} {marker.data.size} bytes, queued {marker.data.queued}");
    schema.AddKeyFormat("size", MS::Format::Bytes);
    schema.AddKeyFormat("queued", MS::Format::Integer);
    return schema;
  }
};

}  // namespace geckoprofiler::markers

#endif  // mozilla_net_MasqueDatagramMarker_h
