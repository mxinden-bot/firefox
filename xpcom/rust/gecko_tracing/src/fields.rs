/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use std::fmt::Write;

use tracing::field::{Field, Visit};

/// Formats a message and its fields as `message key=value key=value`.
pub(crate) struct FieldFormatter<W> {
    pub(crate) out: W,
    pub(crate) first: bool,
}

impl<W: Write> Visit for FieldFormatter<W> {
    // Write strings bare instead of Debug-quoted.
    fn record_str(&mut self, field: &Field, value: &str) {
        self.record_debug(field, &format_args!("{value}"));
    }

    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        let sep = if std::mem::take(&mut self.first) {
            ""
        } else {
            " "
        };
        let _ = if field.name() == "message" {
            write!(self.out, "{sep}{value:?}")
        } else {
            write!(self.out, "{sep}{}={value:?}", field.name())
        };
    }
}
