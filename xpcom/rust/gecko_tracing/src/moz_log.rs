/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! A Rust tracing layer that forwards events to Gecko logging: MOZ_LOG output on
//! stderr or MOZ_LOG_FILE, plus a LOGS profiler marker, as a C++ `MOZ_LOG`
//! call produces.

use std::fmt::Write;

use tracing::{span, subscriber::Interest, Event, Level, Metadata, Subscriber};
use tracing_subscriber::{
    layer::{Context, Filter, Layer},
    registry::LookupSpan,
};

use crate::fields::FieldFormatter;

fn to_log_level(level: Level) -> log::Level {
    match level {
        Level::ERROR => log::Level::Error,
        Level::WARN => log::Level::Warn,
        Level::INFO => log::Level::Info,
        Level::DEBUG => log::Level::Debug,
        Level::TRACE => log::Level::Trace,
    }
}

/// Whether MOZ_LOG enables the callsite's target at its level, like
/// `MOZ_LOG_TEST` in C++.
pub(crate) fn moz_log_test(meta: &Metadata<'_>) -> bool {
    gecko_logger::moz_log_test(meta.target(), to_log_level(*meta.level()))
}

/// Filters events and spans by the MOZ_LOG level of their target. Spans are
/// let through so that their fields can prefix the events logged inside them.
pub struct MozLogFilter;

impl MozLogFilter {
    fn is_enabled(meta: &Metadata<'_>) -> bool {
        moz_log_test(meta)
    }
}

impl<S> Filter<S> for MozLogFilter {
    // Cached per callsite, and rebuilt by gecko_logger when MOZ_LOG changes.
    fn callsite_enabled(&self, meta: &'static Metadata<'static>) -> Interest {
        if Self::is_enabled(meta) {
            Interest::always()
        } else {
            Interest::never()
        }
    }

    // Still called when other filters disagree on the callsite's interest.
    fn enabled(&self, meta: &Metadata<'_>, _cx: &Context<'_, S>) -> bool {
        Self::is_enabled(meta)
    }
}

/// A span's formatted fields, stored in its extensions while it is open.
struct SpanFields(String);

/// Forwards Rust tracing events to Gecko logging, prefixed with the enclosing
/// spans as `name{fields}: `.
pub struct MozLogLayer;

impl<S> Layer<S> for MozLogLayer
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_new_span(&self, attrs: &span::Attributes<'_>, id: &span::Id, ctx: Context<'_, S>) {
        let Some(span) = ctx.span(id) else {
            return;
        };
        let mut fields = String::new();
        attrs.record(&mut FieldFormatter { out: &mut fields });
        span.extensions_mut().insert(SpanFields(fields));
    }

    fn on_record(&self, id: &span::Id, values: &span::Record<'_>, ctx: Context<'_, S>) {
        let Some(span) = ctx.span(id) else {
            return;
        };
        let mut extensions = span.extensions_mut();
        if let Some(fields) = extensions.get_mut::<SpanFields>() {
            values.record(&mut FieldFormatter { out: &mut fields.0 });
        }
    }

    fn on_event(&self, event: &Event<'_>, ctx: Context<'_, S>) {
        let metadata = event.metadata();
        gecko_logger::moz_log(metadata.target(), to_log_level(*metadata.level()), |out| {
            if let Some(scope) = ctx.event_scope(event) {
                for span in scope.from_root() {
                    out.push_str(span.name());
                    if let Some(SpanFields(fields)) = span.extensions().get::<SpanFields>() {
                        if !fields.is_empty() {
                            let _ = write!(out, "{{{fields}}}");
                        }
                    }
                    out.push_str(": ");
                }
            }
            event.record(&mut FieldFormatter { out })
        });
    }
}
