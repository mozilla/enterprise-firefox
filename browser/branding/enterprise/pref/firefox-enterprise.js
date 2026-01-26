/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* global pref */

pref("enterprise.console.address", "https://console.enterfox.eu");

pref("browser.profiles.enabled", false);
pref("extensions.activeThemeID", "firefox-enterprise-light@mozilla.org");

pref("enterprise.loglevel", "Error");

pref(
  "security.certerrors.mitm.priming.endpoint",
  "https://console.enterfox.eu/api/misc/mitm/"
);
pref(
  "captivedetect.canonicalURL",
  "https://console.enterfox.eu/api/misc/protal/canonical.html"
);
pref(
  "network.connectivity-service.IPv4.url",
  "https://console.enterfox.eu/api/misc/connectivity?ipv4"
);
pref(
  "network.connectivity-service.IPv6.url",
  "https://console.enterfox.eu/api/misc/connectivity?ipv6"
);
