/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! A Rust tracing layer that forwards events to Gecko logging: MOZ_LOG output on
//! stderr or MOZ_LOG_FILE, plus a LOGS profiler marker, as a C++ `MOZ_LOG`
//! call produces.

use tracing::{subscriber::Interest, Event, Level, Metadata, Subscriber};
use tracing_subscriber::layer::{Context, Filter, Layer};

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
    gecko_logger::log_enabled(meta.target(), to_log_level(*meta.level()))
}

/// Formats an event's message and fields on demand, so forwarding an event to
/// the `log` crate needs no intermediate buffer.
struct EventMessage<'a, 'b>(&'a Event<'b>);

impl std::fmt::Display for EventMessage<'_, '_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.record(&mut FieldFormatter {
            out: f,
            first: true,
        });
        Ok(())
    }
}

/// Filters events by the MOZ_LOG level of their target.
pub struct MozLogFilter;

impl<S> Filter<S> for MozLogFilter {
    // `sometimes` re-evaluates `enabled` per hit, so runtime MOZ_LOG changes
    // (e.g. about:logging) apply without rebuilding the interest cache.
    fn callsite_enabled(&self, meta: &'static Metadata<'static>) -> Interest {
        if meta.is_event() {
            Interest::sometimes()
        } else {
            Interest::never()
        }
    }

    fn enabled(&self, meta: &Metadata<'_>, _cx: &Context<'_, S>) -> bool {
        meta.is_event() && moz_log_test(meta)
    }
}

/// Forwards Rust tracing events to Gecko logging.
pub struct MozLogLayer;

impl<S: Subscriber> Layer<S> for MozLogLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let metadata = event.metadata();
        log::logger().log(
            &log::Record::builder()
                .args(format_args!("{}", EventMessage(event)))
                .level(to_log_level(*metadata.level()))
                .target(metadata.target())
                .module_path(Some(metadata.target()))
                .file(metadata.file())
                .line(metadata.line())
                .build(),
        );
    }
}
