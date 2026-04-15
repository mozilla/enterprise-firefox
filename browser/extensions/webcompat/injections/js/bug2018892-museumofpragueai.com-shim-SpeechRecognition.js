/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/**
 * Bug 2018892 - shim SpeechRecognition so site works (and hide mic button, since it will not).
 */

if (!window.SpeechRecognition) {
  console.info(
    "SpeechRecognition is being shimmed for compatibility reasons. See https://bugzilla.mozilla.org/show_bug.cgi?id=2018892 for details."
  );

  window.SpeechRecognition = function () {};

  window.addEventListener("DOMContentLoaded", () => {
    const style = document.createElement("style");
    style.innerText = "#micBtn { display: none; }";
    document.head.appendChild(style);
  });
}
