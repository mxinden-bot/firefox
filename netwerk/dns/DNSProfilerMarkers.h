/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef DNSProfilerMarkers_h__
#define DNSProfilerMarkers_h__

#include "mozilla/ProfilerMarkers.h"
#include "mozilla/Span.h"

namespace geckoprofiler::markers {

// Profiler marker used along the HTTPS RR (HTTPSSVC) resolution code path.
// Together with the "Happy Eyeballs" markers emitted by
// netwerk/protocol/http/happy_eyeballs_glue, these markers break down where
// time is spent between a consumer requesting an HTTPS record and the
// response being delivered back to it.
struct HTTPSRRMarker {
  static constexpr mozilla::Span<const char> MarkerTypeName() {
    return mozilla::MakeStringSpan("HTTPSRR");
  }
  static void StreamJSONMarkerData(
      mozilla::baseprofiler::SpliceableJSONWriter& aWriter,
      const mozilla::ProfilerString8View& aHost,
      const mozilla::ProfilerString8View& aDetail) {
    aWriter.StringProperty("host", aHost);
    if (aDetail.Length() != 0) {
      aWriter.StringProperty("detail", aDetail);
    }
  }
  static mozilla::MarkerSchema MarkerTypeDisplay() {
    using MS = mozilla::MarkerSchema;
    MS schema(MS::Location::MarkerChart, MS::Location::MarkerTable);
    schema.SetChartLabel("{marker.data.host}");
    schema.SetTableLabel(
        "{marker.name} - {marker.data.host} {marker.data.detail}");
    schema.AddKeyLabelFormat("host", "Host", MS::Format::SanitizedString);
    schema.AddKeyLabelFormat("detail", "Detail", MS::Format::SanitizedString);
    return schema;
  }
};

}  // namespace geckoprofiler::markers

#endif  // DNSProfilerMarkers_h__
