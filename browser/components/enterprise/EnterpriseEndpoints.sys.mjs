/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const CONSOLE_ADDRESS_PREF = "enterprise.console.address";

const ENDPOINT_PREFS = [
  {
    pref: "security.certerrors.mitm.priming.endpoint",
    path: "api/misc/mitm/",
  },
  {
    pref: "captivedetect.canonicalURL",
    path: "api/misc/portal/canonical.html",
  },
  {
    pref: "network.connectivity-service.IPv4.url",
    path: "api/misc/connectivity?ipv4",
  },
  {
    pref: "network.connectivity-service.IPv6.url",
    path: "api/misc/connectivity?ipv6",
  },
];

export const EnterpriseEndpoints = {
  init() {
    const consoleAddress = Services.prefs.getStringPref(
      CONSOLE_ADDRESS_PREF,
      ""
    );
    if (!consoleAddress) {
      return;
    }

    let baseURL;
    try {
      baseURL = new URL(consoleAddress);
    } catch {
      return;
    }

    const defaultBranch = Services.prefs.getDefaultBranch("");
    for (const { pref, path } of ENDPOINT_PREFS) {
      const url = new URL(path, baseURL).href;
      defaultBranch.setStringPref(pref, url);
    }
  },
};
