/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! This provides a way to set up rust tracing "layers".
mod layer;

pub fn initialize_tracing() {
    use tracing_subscriber::prelude::*;
    tracing_subscriber::registry()
        // The application-services tracing-support library, which directs tracing from some crates
        // back into the application for logging or other diagnostic purposes.
        .with(tracing_support::simple_event_layer())
        // Route tracing events through Gecko's logging (stderr/MOZ_LOG plus
        // profiler markers, like a C++ MOZ_LOG call) and record tracing spans
        // as profiler duration markers. See
        // https://bugzilla.mozilla.org/show_bug.cgi?id=1652558.
        .with(layer::layer())
        // More layers can be added by additional `.with(...)` statements.
        .init();
}
