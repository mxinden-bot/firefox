/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_net_Http3Markers_h
#define mozilla_net_Http3Markers_h

#include "mozilla/ProfilerMarkers.h"
#include "mozilla/TimeStamp.h"

namespace mozilla::net {

// Which of the connections a marker belongs to. The inner and outer halves of a
// connect-udp tunnel run on the same socket thread, so markers are otherwise
// indistinguishable.
enum class Http3SessionKind : uint8_t {
  Direct = 0,
  Outer = 1,
  Inner = 2,
};

inline mozilla::Span<const char> Http3SessionKindString(uint8_t aKind) {
  switch (static_cast<Http3SessionKind>(aKind)) {
    case Http3SessionKind::Outer:
      return mozilla::MakeStringSpan("outer");
    case Http3SessionKind::Inner:
      return mozilla::MakeStringSpan("inner");
    default:
      return mozilla::MakeStringSpan("direct");
  }
}

}  // namespace mozilla::net

namespace geckoprofiler::markers {

// Identifies the session a socket-thread marker came from.
struct Http3SessionMarker {
  static constexpr mozilla::Span<const char> MarkerTypeName() {
    return mozilla::MakeStringSpan("Http3Session");
  }
  static void StreamJSONMarkerData(
      mozilla::baseprofiler::SpliceableJSONWriter& aWriter, uint32_t aSessionId,
      uint8_t aKind) {
    aWriter.IntProperty("session", aSessionId);
    aWriter.StringProperty("kind", mozilla::net::Http3SessionKindString(aKind));
  }
  static mozilla::MarkerSchema MarkerTypeDisplay() {
    using MS = mozilla::MarkerSchema;
    MS schema{MS::Location::MarkerChart, MS::Location::MarkerTable};
    schema.SetTableLabel("{marker.name} {marker.data.kind} #{marker.data.session}");
    schema.AddKeyFormat("session", MS::Format::Integer);
    schema.AddKeyFormat("kind", MS::Format::String);
    return schema;
  }
};

// What neqo asked to be woken after, and what actually got armed. `requestedUs`
// below 1000 is truncated to a 0 ms timer.
struct Http3SetupTimerMarker {
  static constexpr mozilla::Span<const char> MarkerTypeName() {
    return mozilla::MakeStringSpan("Http3SetupTimer");
  }
  static void StreamJSONMarkerData(
      mozilla::baseprofiler::SpliceableJSONWriter& aWriter, uint32_t aSessionId,
      uint8_t aKind, uint64_t aRequestedUs, uint64_t aArmedMs, bool aClamped) {
    aWriter.IntProperty("session", aSessionId);
    aWriter.StringProperty("kind", mozilla::net::Http3SessionKindString(aKind));
    aWriter.IntProperty("requestedUs", aRequestedUs);
    aWriter.IntProperty("armedMs", aArmedMs);
    aWriter.BoolProperty("clamped", aClamped);
  }
  static mozilla::MarkerSchema MarkerTypeDisplay() {
    using MS = mozilla::MarkerSchema;
    MS schema{MS::Location::MarkerChart, MS::Location::MarkerTable};
    schema.SetTableLabel(
        "{marker.name} {marker.data.kind} requested {marker.data.requestedUs}us "
        "armed {marker.data.armedMs}ms");
    schema.AddKeyFormat("session", MS::Format::Integer);
    schema.AddKeyFormat("kind", MS::Format::String);
    schema.AddKeyFormat("requestedUs", MS::Format::Microseconds);
    schema.AddKeyFormat("armedMs", MS::Format::Milliseconds);
    schema.AddKeyFormat("clamped", MS::Format::String);
    return schema;
  }
};

// Why a process_output drain stopped, and what it produced.
struct Http3ProcessOutputMarker {
  static constexpr mozilla::Span<const char> MarkerTypeName() {
    return mozilla::MakeStringSpan("Http3ProcessOutput");
  }
  static void StreamJSONMarkerData(
      mozilla::baseprofiler::SpliceableJSONWriter& aWriter, uint32_t aSessionId,
      uint8_t aKind, uint8_t aExit, uint32_t aPackets, uint32_t aBytes,
      uint64_t aCallbackUs) {
    aWriter.IntProperty("session", aSessionId);
    aWriter.StringProperty("kind", mozilla::net::Http3SessionKindString(aKind));
    aWriter.StringProperty("exit", ExitString(aExit));
    aWriter.IntProperty("packets", aPackets);
    aWriter.IntProperty("bytes", aBytes);
    aWriter.IntProperty("callbackUs", aCallbackUs);
  }
  static mozilla::MarkerSchema MarkerTypeDisplay() {
    using MS = mozilla::MarkerSchema;
    MS schema{MS::Location::MarkerChart, MS::Location::MarkerTable};
    schema.SetTableLabel(
        "{marker.name} {marker.data.kind} {marker.data.exit} "
        "{marker.data.packets} pkts {marker.data.bytes} bytes");
    schema.AddKeyFormat("session", MS::Format::Integer);
    schema.AddKeyFormat("kind", MS::Format::String);
    schema.AddKeyFormat("exit", MS::Format::String);
    schema.AddKeyFormat("packets", MS::Format::Integer);
    schema.AddKeyFormat("bytes", MS::Format::Bytes);
    schema.AddKeyFormat("callbackUs", MS::Format::Microseconds);
    return schema;
  }

 private:
  // Mirrors the OutputExit enum in neqo_glue.
  static mozilla::Span<const char> ExitString(uint8_t aExit) {
    switch (aExit) {
      case 0:
        return mozilla::MakeStringSpan("Callback");
      case 1:
        return mozilla::MakeStringSpan("None");
      case 2:
        return mozilla::MakeStringSpan("WouldBlock");
      default:
        return mozilla::MakeStringSpan("Error");
    }
  }
};

// Emitted when PMTUD moves the probed path MTU.
struct Http3PmtuMarker {
  static constexpr mozilla::Span<const char> MarkerTypeName() {
    return mozilla::MakeStringSpan("Http3Pmtu");
  }
  static void StreamJSONMarkerData(
      mozilla::baseprofiler::SpliceableJSONWriter& aWriter, uint32_t aSessionId,
      uint8_t aKind, uint64_t aPlpmtu, uint64_t aPrevious) {
    aWriter.IntProperty("session", aSessionId);
    aWriter.StringProperty("kind", mozilla::net::Http3SessionKindString(aKind));
    aWriter.IntProperty("plpmtu", aPlpmtu);
    aWriter.IntProperty("previous", aPrevious);
  }
  static mozilla::MarkerSchema MarkerTypeDisplay() {
    using MS = mozilla::MarkerSchema;
    MS schema{MS::Location::MarkerChart, MS::Location::MarkerTable};
    schema.SetTableLabel(
        "{marker.name} {marker.data.kind} {marker.data.previous} -> "
        "{marker.data.plpmtu}");
    schema.AddKeyFormat("session", MS::Format::Integer);
    schema.AddKeyFormat("kind", MS::Format::String);
    schema.AddKeyFormat("plpmtu", MS::Format::Bytes);
    schema.AddKeyFormat("previous", MS::Format::Bytes);
    return schema;
  }
};

// Emitted when neqo's outbound datagram drop counters move.
struct Http3DatagramStatsMarker {
  static constexpr mozilla::Span<const char> MarkerTypeName() {
    return mozilla::MakeStringSpan("Http3DatagramStats");
  }
  static void StreamJSONMarkerData(
      mozilla::baseprofiler::SpliceableJSONWriter& aWriter, uint32_t aSessionId,
      uint8_t aKind, uint64_t aLost, uint64_t aDroppedTooBig) {
    aWriter.IntProperty("session", aSessionId);
    aWriter.StringProperty("kind", mozilla::net::Http3SessionKindString(aKind));
    aWriter.IntProperty("lost", aLost);
    aWriter.IntProperty("droppedTooBig", aDroppedTooBig);
  }
  static mozilla::MarkerSchema MarkerTypeDisplay() {
    using MS = mozilla::MarkerSchema;
    MS schema{MS::Location::MarkerChart, MS::Location::MarkerTable};
    schema.SetTableLabel(
        "{marker.name} {marker.data.kind} lost {marker.data.lost} tooBig "
        "{marker.data.droppedTooBig}");
    schema.AddKeyFormat("session", MS::Format::Integer);
    schema.AddKeyFormat("kind", MS::Format::String);
    schema.AddKeyFormat("lost", MS::Format::Integer);
    schema.AddKeyFormat("droppedTooBig", MS::Format::Integer);
    return schema;
  }
};

}  // namespace geckoprofiler::markers

namespace mozilla::net {

// Interval marker carrying the session it belongs to. Mirrors
// AutoProfilerUntypedMarker, which cannot carry a payload.
class MOZ_RAII AutoHttp3SessionMarker {
 public:
  AutoHttp3SessionMarker(const char* aMarkerName, uint32_t aSessionId,
                         Http3SessionKind aKind)
      : mMarkerName(aMarkerName),
        mSessionId(aSessionId),
        mKind(static_cast<uint8_t>(aKind)) {
    if (profiler_is_active_and_unpaused()) {
      mStart = TimeStamp::Now();
    }
  }

  ~AutoHttp3SessionMarker() {
    if (mStart.IsNull() || !profiler_is_active_and_unpaused()) {
      return;
    }
    PROFILER_MARKER(
        ProfilerString8View::WrapNullTerminatedString(mMarkerName), NETWORK,
        MarkerOptions(MarkerTiming::IntervalUntilNowFrom(mStart)),
        Http3SessionMarker, mSessionId, mKind);
  }

 private:
  const char* mMarkerName;
  uint32_t mSessionId;
  uint8_t mKind;
  TimeStamp mStart;
};

}  // namespace mozilla::net

#endif  // mozilla_net_Http3Markers_h
