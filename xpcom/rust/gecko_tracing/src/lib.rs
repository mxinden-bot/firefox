/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! This provides a way to set up rust tracing "layers".
mod fields;
mod moz_log;
mod span_marker;

use tracing::{subscriber::Interest, Metadata};
use tracing_subscriber::layer::{Context, Filter};

/// Copy of application-services' private `SimpleEventFilter`: enables callsites
/// emitted by `tracing_support` macros.
///
/// TODO: use the upstream filter once
/// <https://github.com/mozilla/application-services/pull/7635> is vendored.
struct TracingSupportFilter;

impl TracingSupportFilter {
    fn should_process_callsite(meta: &Metadata<'_>) -> bool {
        meta.fields().field("tracing_support").is_some()
    }
}

impl<S> Filter<S> for TracingSupportFilter {
    fn callsite_enabled(&self, meta: &'static Metadata<'static>) -> Interest {
        if Self::should_process_callsite(meta) {
            Interest::always()
        } else {
            Interest::never()
        }
    }

    fn enabled(&self, meta: &Metadata<'_>, _cx: &Context<'_, S>) -> bool {
        Self::should_process_callsite(meta)
    }
}

pub fn initialize_tracing() {
    use tracing_subscriber::{filter::FilterExt as _, prelude::*};
    tracing_subscriber::registry()
        // The application-services tracing-support library, which directs tracing from some crates
        // back into the application for logging or other diagnostic purposes.
        .with(tracing_support::simple_event_layer())
        // Forward events to Gecko logging. Events from tracing-support are
        // filtered out, thus only handled above.
        .with(
            moz_log::MozLogLayer.with_filter(moz_log::MozLogFilter.and(TracingSupportFilter.not())),
        )
        // Record spans as profiler duration markers, again excluding
        // tracing-support.
        .with(
            span_marker::SpanMarkerLayer
                .with_filter(span_marker::SpanMarkerFilter.and(TracingSupportFilter.not())),
        )
        // More layers can be added by additional `.with(...)` statements.
        .init();
}
