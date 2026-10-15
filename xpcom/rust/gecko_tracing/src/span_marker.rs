/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! A Rust tracing layer that records spans as profiler duration markers.

use gecko_profiler::{
    add_text_marker, gecko_profiler_category, MarkerOptions, MarkerTiming, ProfilerTime,
};
use tracing::{span, subscriber::Interest, Metadata, Subscriber};
use tracing_subscriber::{
    layer::{Context, Filter, Layer},
    registry::LookupSpan,
};

use crate::{fields::FieldFormatter, moz_log::moz_log_test};

/// Stored in a span's extensions so that, when the span closes, the resulting
/// marker can cover the span's whole lifetime as an interval (duration) marker.
struct SpanTiming {
    start: ProfilerTime,
    fields: String,
}

/// Filters spans by the MOZ_LOG level of their target, and only while the
/// current thread is being profiled.
pub struct SpanMarkerFilter;

impl<S> Filter<S> for SpanMarkerFilter {
    // Cached per callsite, and rebuilt by gecko_logger when MOZ_LOG changes.
    // `sometimes` rather than `always`: `enabled` also checks the profiler.
    fn callsite_enabled(&self, meta: &'static Metadata<'static>) -> Interest {
        // TODO: misuses MOZ_LOG targets and levels until profiler markers
        // can be filtered by emitter (bug 2069963).
        if meta.is_span() && moz_log_test(meta) {
            Interest::sometimes()
        } else {
            Interest::never()
        }
    }

    // Called on every span, since `callsite_enabled` returns `sometimes`. Only
    // the profiler state needs checking here: the MOZ_LOG decision is cached
    // per callsite by `callsite_enabled`, and set_rust_log_level clears that
    // cache whenever MOZ_LOG changes.
    fn enabled(&self, meta: &Metadata<'_>, _cx: &Context<'_, S>) -> bool {
        meta.is_span() && gecko_profiler::current_thread_is_being_profiled_for_markers()
    }
}

/// Records Rust tracing spans as profiler interval markers.
pub struct SpanMarkerLayer;

impl<S> Layer<S> for SpanMarkerLayer
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_new_span(&self, attrs: &span::Attributes<'_>, id: &span::Id, ctx: Context<'_, S>) {
        let Some(span) = ctx.span(id) else {
            return;
        };
        let mut fields = String::new();
        attrs.record(&mut FieldFormatter { out: &mut fields });
        span.extensions_mut().insert(SpanTiming {
            start: ProfilerTime::now(),
            fields,
        });
    }

    fn on_record(&self, id: &span::Id, values: &span::Record<'_>, ctx: Context<'_, S>) {
        let Some(span) = ctx.span(id) else {
            return;
        };
        let mut extensions = span.extensions_mut();
        if let Some(timing) = extensions.get_mut::<SpanTiming>() {
            values.record(&mut FieldFormatter {
                out: &mut timing.fields,
            });
        }
    }

    fn on_close(&self, id: span::Id, ctx: Context<'_, S>) {
        let Some(span) = ctx.span(&id) else {
            return;
        };
        let Some(timing) = span.extensions_mut().remove::<SpanTiming>() else {
            return;
        };
        add_text_marker(
            span.metadata().name(),
            gecko_profiler_category!(Logs),
            MarkerOptions {
                timing: MarkerTiming::interval_until_now_from(timing.start),
                ..Default::default()
            },
            &timing.fields,
        );
    }
}
