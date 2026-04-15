/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/**
 * Bug 2012789 - Draw feature doesn't work on www.zoopla.co.uk without a touchscreen.
 *
 * The site presumes that TouchEvent is always defined, which isn't the
 * case on Firefox unless a touchscreen is detected. We can set it to MouseEvent.
 */

if (!window.TouchEvent) {
  console.info(
    "window.TouchEvent is being set to window.MouseEvent for compatibility reasons. See https://bugzilla.mozilla.org/show_bug.cgi?id=2012789 for details."
  );

  window.TouchEvent = window.MouseEvent;
}
