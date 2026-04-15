/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/**
 * Bug 1902520 - news.yahoo.co.jp - Override UA on Windows.
 * WebCompat issue #118144 - https://webcompat.com/issues/118144
 *
 * The site blocks Firefox, serving different HTML which checks for
 * Windows 11 in the UA string. We can serve it what it wants.
 */

if (!navigator.userAgent.includes("Chrome")) {
  console.info(
    "The user agent has been overridden for compatibility reasons. See https://bugzil.la/1902520 for details."
  );

  const CHROME_UA = `Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36`;

  const nav = Object.getPrototypeOf(navigator);
  const ua = Object.getOwnPropertyDescriptor(nav, "userAgent");
  ua.get = () => CHROME_UA;
  Object.defineProperty(nav, "userAgent", ua);
}
