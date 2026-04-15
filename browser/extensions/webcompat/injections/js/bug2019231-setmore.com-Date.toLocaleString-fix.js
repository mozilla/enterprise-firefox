/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/**
 * Bug 2019231 - youthrockband.setmore.com does not load
 *
 * The site is not always passing standard values to Date.toLocaleString, which
 * throws an exception on Firefox (but works on Chrome). We can detect this
 * and change the value to a standard one.
 */

try {
  new Date().toLocaleString("en", {
    weekday: "long",
    timeZone: "SystemV/CST6",
  });
} catch (_) {
  console.info(
    "Date.toLocaleString and Intl.DateTimeFormat are being shimmed for compatibility reasons. See https://bugzilla.mozilla.org/show_bug.cgi?id=2019231 for details."
  );

  const buildFixed = value => {
    return function () {
      switch (
        arguments[1]?.timeZone?.toUpperCase().split("/").pop().substr(0, 3)
      ) {
        case "AST":
          arguments[1].timeZone = "America/Anchorage";
          break;
        case "EST":
          arguments[1].timeZone = "America/New_York";
          break;
        case "CST":
          arguments[1].timeZone = "America/Chicago";
          break;
        case "HST":
          arguments[1].timeZone = "Pacific/Honolulu";
          break;
        case "MST":
          arguments[1].timeZone = "America/Denver";
          break;
        case "PST":
          arguments[1].timeZone = "America/Los_Angeles";
          break;
        case "SST":
          arguments[1].timeZone = "Pacific/Pago_Pago";
          break;
      }
      return value.apply(this, arguments);
    };
  };

  {
    const desc = Object.getOwnPropertyDescriptor(
      window.Date.prototype,
      "toLocaleString"
    );
    const { value } = desc;
    desc.value = buildFixed(value);
    Object.defineProperty(window.Date.prototype, "toLocaleString", desc);
  }

  {
    const desc = Object.getOwnPropertyDescriptor(window.Intl, "DateTimeFormat");
    const { value } = desc;
    desc.value = buildFixed(value);
    Object.defineProperty(window.Intl, "DateTimeFormat", desc);
  }
}
