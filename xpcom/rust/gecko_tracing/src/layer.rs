/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! A `tracing` layer that mirrors the C++ MOZ_LOG fan-out for Rust `tracing`.
//!
//! - Events are forwarded to the `log` crate, where `GeckoLogger` turns them
//!   into the same stderr/MOZ_LOG_FILE output and `LOGS`-category profiler
//!   markers that a C++ `MOZ_LOG` call produces. They therefore obey MOZ_LOG
//!   (and RUST_LOG) levels for free.
//! - Spans are recorded as interval (duration) markers in the profiler only,
//!   gated by the same MOZ_LOG levels.

use std::fmt::Write as _;

use gecko_profiler::{add_text_marker, gecko_profiler_category, MarkerOptions, MarkerTiming,
    ProfilerTime};
use tracing::{
    field::{Field, Visit},
    span, Event, Level, Subscriber,
};
use tracing_subscriber::{layer::Context, registry::LookupSpan, Layer};

/// Collects an event's or span's message and fields into a single string.
struct MessageVisitor<'a> {
    text: &'a mut String,
}

impl Visit for MessageVisitor<'_> {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if !self.text.is_empty() {
            self.text.push(' ');
        }
        if field.name() == "message" {
            let _ = write!(self.text, "{value:?}");
        } else {
            let _ = write!(self.text, "{}={value:?}", field.name());
        }
    }
}

fn to_log_level(level: &Level) -> log::Level {
    match *level {
        Level::ERROR => log::Level::Error,
        Level::WARN => log::Level::Warn,
        Level::INFO => log::Level::Info,
        Level::DEBUG => log::Level::Debug,
        Level::TRACE => log::Level::Trace,
    }
}

/// Stored in a span's extensions so that, when the span closes, the resulting
/// marker can cover the span's whole lifetime as an interval (duration) marker.
struct SpanTiming {
    start: ProfilerTime,
    fields: String,
}

struct GeckoLayer;

impl<S> Layer<S> for GeckoLayer
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let metadata = event.metadata();
        let level = to_log_level(metadata.level());
        if log::max_level() < level {
            return;
        }

        // TODO(perf): needs profiling. `log::max_level()` is only a global
        // ceiling, so once any rust module is verbose this runs for every
        // event in the process, allocating `text` and formatting all fields
        // before we know whether this specific target is enabled. C++ MOZ_LOG
        // gates per-module first (MOZ_LOG_TEST). Consider gating on
        // `gecko_logger::log_enabled` (or `register_callsite`/`enabled`
        // returning `Interest::never` for disabled targets) and reusing a
        // thread-local buffer to avoid the per-event allocation. Note also that
        // GeckoLogger re-formats `record.args()`, so the message is built twice.
        let mut text = String::new();
        event.record(&mut MessageVisitor { text: &mut text });

        // Forwarding to the `log` crate reuses GeckoLogger, which applies the
        // MOZ_LOG/RUST_LOG levels and produces both the stderr line and the
        // LOGS profiler marker, exactly like a C++ MOZ_LOG call.
        log::logger().log(
            &log::Record::builder()
                .args(format_args!("{text}"))
                .level(level)
                .target(metadata.target())
                .module_path(Some(metadata.target()))
                .file(metadata.file())
                .line(metadata.line())
                .build(),
        );
    }

    fn on_new_span(&self, attrs: &span::Attributes<'_>, id: &span::Id, ctx: Context<'_, S>) {
        let metadata = attrs.metadata();
        if !gecko_logger::log_enabled(metadata.target(), to_log_level(metadata.level())) {
            return;
        }
        let Some(span) = ctx.span(id) else {
            return;
        };
        // TODO(perf): needs profiling. `ProfilerTime::now()` runs for every
        // span on hot paths (e.g. neqo_glue's per-call process_input/
        // process_output_and_send).
        span.extensions_mut().insert(SpanTiming {
            start: ProfilerTime::now(),
            // Only fields added later via `Span::record` (see `on_record`) are
            // captured; the current spans fill their values that way.
            fields: String::new(),
        });
    }

    fn on_record(&self, id: &span::Id, values: &span::Record<'_>, ctx: Context<'_, S>) {
        let Some(span) = ctx.span(id) else {
            return;
        };
        let mut extensions = span.extensions_mut();
        if let Some(timing) = extensions.get_mut::<SpanTiming>() {
            values.record(&mut MessageVisitor {
                text: &mut timing.fields,
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

/// Returns the layer that forwards tracing events to the Gecko logging and
/// profiler infrastructure.
pub fn layer<S>() -> impl Layer<S>
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    GeckoLayer
}
