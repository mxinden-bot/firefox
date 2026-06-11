/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef DNSProfilerMarkers_h__
#define DNSProfilerMarkers_h__

#include "mozilla/ProfilerMarkers.h"
#include "mozilla/Span.h"
#include "nsIDNSService.h"
#include "prio.h"

namespace geckoprofiler::markers {

// Profiler marker used along the DNS resolution code path, with a focus on
// making HTTPS RR (HTTPSSVC) resolution debuggable. Together with the
// "Happy Eyeballs" markers emitted by
// netwerk/protocol/http/happy_eyeballs_glue, these markers break down where
// time is spent between a consumer requesting a DNS record and the response
// being delivered back to it.
struct DNSQueryMarker {
  static constexpr mozilla::Span<const char> MarkerTypeName() {
    return mozilla::MakeStringSpan("DNSQuery");
  }
  static void StreamJSONMarkerData(
      mozilla::baseprofiler::SpliceableJSONWriter& aWriter,
      const mozilla::ProfilerString8View& aHost,
      const mozilla::ProfilerString8View& aQueryType,
      const mozilla::ProfilerString8View& aOutcome,
      const mozilla::ProfilerString8View& aStatus, int64_t aRecords,
      const mozilla::ProfilerString8View& aDetail) {
    aWriter.StringProperty("host", aHost);
    aWriter.UniqueStringProperty("qtype", aQueryType);
    if (aOutcome.Length() != 0) {
      aWriter.UniqueStringProperty("outcome", aOutcome);
    }
    if (aStatus.Length() != 0) {
      aWriter.StringProperty("status", aStatus);
    }
    if (aRecords >= 0) {
      aWriter.IntProperty("records", aRecords);
    }
    if (aDetail.Length() != 0) {
      aWriter.StringProperty("detail", aDetail);
    }
  }
  static mozilla::MarkerSchema MarkerTypeDisplay() {
    using MS = mozilla::MarkerSchema;
    MS schema(MS::Location::MarkerChart, MS::Location::MarkerTable);
    schema.SetChartLabel("{marker.data.qtype} {marker.data.host}");
    schema.SetTableLabel(
        "{marker.name} - {marker.data.qtype} {marker.data.host} "
        "{marker.data.outcome} {marker.data.detail}");
    schema.AddKeyLabelFormat("host", "Host", MS::Format::SanitizedString);
    schema.AddKeyLabelFormat("qtype", "Record Type", MS::Format::UniqueString);
    schema.AddKeyLabelFormat("outcome", "Outcome", MS::Format::UniqueString);
    schema.AddKeyLabelFormat("status", "Status", MS::Format::String);
    schema.AddKeyLabelFormat("records", "Records", MS::Format::Integer);
    schema.AddKeyLabelFormat("detail", "Detail", MS::Format::SanitizedString);
    return schema;
  }
};

}  // namespace geckoprofiler::markers

namespace mozilla::net {

// Human readable record type for a (RESOLVE_TYPE_*, address family) pair.
inline mozilla::ProfilerString8View DNSQueryTypeString(uint16_t aType,
                                                       uint16_t aAF) {
  switch (aType) {
    case nsIDNSService::RESOLVE_TYPE_HTTPSSVC:
      return "HTTPS";
    case nsIDNSService::RESOLVE_TYPE_TXT:
      return "TXT";
    default:
      break;
  }
  if (aAF == PR_AF_INET) {
    return "A";
  }
  if (aAF == PR_AF_INET6) {
    return "AAAA";
  }
  return "A+AAAA";
}

}  // namespace mozilla::net

#endif  // DNSProfilerMarkers_h__
