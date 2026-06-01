/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! A [`tracing`] layer that turns tracing spans and events into [Gecko
//! Profiler] markers.
//!
//! This is the integration that lets Rust code be instrumented for the profiler
//! using nothing more than the ordinary `tracing` macros, e.g.
//!
//! ```ignore
//! #[tracing::instrument(skip_all)]
//! fn do_work() { /* ... */ }
//!
//! tracing::info!(bytes = 42, "received datagram");
//! ```
//!
//! rather than having each crate reach for bespoke profiler FFI. A span becomes
//! an *interval* marker covering the time the span was entered, and an event
//! becomes an *instant* marker. The span/event fields are rendered into the
//! marker's detail text.
//!
//! [Gecko Profiler]: https://firefox-source-docs.mozilla.org/tools/profiler/

use std::fmt;
use std::fmt::Write as _;

use gecko_profiler::{
    add_text_marker, gecko_profiler_category, MarkerOptions, MarkerTiming, ProfilerTime,
};
use tracing::field::{Field, Visit};
use tracing::span::{Attributes, Id};
use tracing::subscriber::Interest;
use tracing::{Event, Metadata, Subscriber};
use tracing_subscriber::layer::{Context, Filter, Layer};
use tracing_subscriber::registry::LookupSpan;

/// State we stash in a span's [extensions] so that we can emit a single
/// interval marker spanning each time the span is active on a thread.
///
/// We deliberately key the interval off `on_enter`/`on_exit` rather than the
/// span's whole lifetime (`on_new_span`/`on_close`). For synchronous code the
/// two coincide, but for code that is entered and exited repeatedly (e.g. a
/// future polled across several `.await`s) the enter/exit pairs are the only
/// intervals during which the instrumented code is actually running on a
/// thread, which is exactly what the profiler wants to attribute time to. It
/// also guarantees the marker is emitted on the same thread that did the work.
///
/// [extensions]: tracing_subscriber::registry::SpanRef::extensions
struct SpanState {
    /// The span's fields, pre-rendered once at creation, reused as the detail
    /// text of every interval marker the span produces.
    detail: String,
    /// How many times the span is currently entered. A span can be entered
    /// re-entrantly; we coalesce nested entries into the outermost interval so
    /// that we never emit overlapping markers for a single span.
    depth: u32,
    /// When the outermost active entry began. `Some` exactly while `depth > 0`.
    start: Option<ProfilerTime>,
}

/// A [`Visit`]or that renders fields into `key=value` form, space-separated,
/// with the special `message` field (the format string of a `tracing` macro)
/// emitted bare.
struct DetailVisitor<'a>(&'a mut String);

impl Visit for DetailVisitor<'_> {
    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        if !self.0.is_empty() {
            let _ = self.0.write_str(", ");
        }
        if field.name() == "message" {
            let _ = write!(self.0, "{value:?}");
        } else {
            let _ = write!(self.0, "{}={value:?}", field.name());
        }
    }
}

fn render_fields<F: FnOnce(&mut DetailVisitor)>(record: F) -> String {
    let mut detail = String::new();
    record(&mut DetailVisitor(&mut detail));
    detail
}

/// The [`Layer`] that emits profiler markers. It is paired with
/// [`ProfilerMarkerFilter`] (see [`layer`]) so that the relatively expensive
/// span bookkeeping only happens while the profiler is actually recording.
struct ProfilerMarkerLayer;

impl<S> Layer<S> for ProfilerMarkerLayer
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_new_span(&self, attrs: &Attributes<'_>, id: &Id, ctx: Context<'_, S>) {
        let Some(span) = ctx.span(id) else {
            return;
        };
        span.extensions_mut().insert(SpanState {
            detail: render_fields(|v| attrs.record(v)),
            depth: 0,
            start: None,
        });
    }

    fn on_enter(&self, id: &Id, ctx: Context<'_, S>) {
        let Some(span) = ctx.span(id) else {
            return;
        };
        let mut extensions = span.extensions_mut();
        if let Some(state) = extensions.get_mut::<SpanState>() {
            if state.depth == 0 {
                state.start = Some(ProfilerTime::now());
            }
            state.depth += 1;
        }
    }

    fn on_exit(&self, id: &Id, ctx: Context<'_, S>) {
        let Some(span) = ctx.span(id) else {
            return;
        };
        let mut extensions = span.extensions_mut();
        let Some(state) = extensions.get_mut::<SpanState>() else {
            return;
        };
        if state.depth == 0 {
            // Unbalanced exit; nothing to do.
            return;
        }
        state.depth -= 1;
        if state.depth != 0 {
            // Still inside an outer entry of the same span.
            return;
        }
        let Some(start) = state.start.take() else {
            return;
        };
        add_text_marker(
            span.name(),
            gecko_profiler_category!(Other),
            MarkerOptions {
                timing: MarkerTiming::interval_until_now_from(start),
                ..Default::default()
            },
            &state.detail,
        );
    }

    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        add_text_marker(
            event.metadata().name(),
            gecko_profiler_category!(Other),
            MarkerOptions {
                timing: MarkerTiming::instant_now(),
                ..Default::default()
            },
            &render_fields(|v| event.record(v)),
        );
    }
}

/// A per-layer [`Filter`] that enables [`ProfilerMarkerLayer`] only while the
/// current thread is being profiled for markers.
///
/// Because whether the profiler is recording can change at runtime, we cannot
/// let `tracing` cache a callsite's interest. We therefore report
/// [`Interest::sometimes`], which costs a cheap thread-local check
/// ([`current_thread_is_being_profiled_for_markers`]) per span/event when the
/// profiler is off, and no span allocation at all in that case.
///
/// [`current_thread_is_being_profiled_for_markers`]:
///     gecko_profiler::current_thread_is_being_profiled_for_markers
struct ProfilerMarkerFilter;

impl<S> Filter<S> for ProfilerMarkerFilter
where
    S: Subscriber,
{
    fn callsite_enabled(&self, _meta: &'static Metadata<'static>) -> Interest {
        Interest::sometimes()
    }

    fn enabled(&self, _meta: &Metadata<'_>, _ctx: &Context<'_, S>) -> bool {
        gecko_profiler::current_thread_is_being_profiled_for_markers()
    }
}

/// Build the profiler-marker [`Layer`], ready to be added to a
/// `tracing_subscriber` registry. See the [module docs](self).
pub fn layer<S>() -> impl Layer<S>
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    ProfilerMarkerLayer.with_filter(ProfilerMarkerFilter)
}
