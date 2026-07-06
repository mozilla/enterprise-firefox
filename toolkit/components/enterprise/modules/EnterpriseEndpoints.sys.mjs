/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ConsoleClient: "resource://gre/modules/enterprise/ConsoleClient.sys.mjs",
  createEnterpriseLogger:
    "resource://gre/modules/enterprise/EnterpriseCommon.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  return lazy.createEnterpriseLogger("EnterpriseEndpoints");
});

// Todo: Bug 2024702
// We've nulled preferences that pointed to Mozilla servers and disabled respective features.
// See https://github.com/mozilla/enterprise-firefox/commit/937f94b78c4c759f3b2a06c8ac52c5accb688c31
// We are replacing some here. But we need to take a look at the missing ones to avoid breakage.

export const RELATIVE_CONSOLE_ENDPOINT_PREFS = [
  { pref: "identity.fxaccounts.remote.oauth.uri", path: "api/fxa/oauth/v1" },
  {
    pref: "identity.fxaccounts.remote.profile.uri",
    path: "api/fxa/profile/v1",
  },
  {
    pref: "identity.fxaccounts.auth.uri",
    path: "api/fxa/api/v1",
  },
  {
    pref: "security.certerrors.mitm.priming.endpoint",
    path: "api/misc/mitm/",
  },
  // Note: captive-portal detection (captivedetect.canonicalURL) and the
  // connectivity service (network.connectivity-service.IPv4/IPv6.url) are
  // intentionally NOT re-homed onto the console. Those probes must be plaintext
  // HTTP requests to an endpoint a captive portal can transparently intercept;
  // the console is HTTPS and is itself unreachable behind a portal, so routing
  // them through it breaks detection entirely (bug 2037079). They keep the
  // standard detectportal.firefox.com defaults instead.
];

export const BASE_CONSOLE_URI_PREFS = new Set([
  "browser.ipProtection.guardian.endpoint",
  "identity.fxaccounts.remote.root",
]);

export const EnterpriseEndpoints = {
  async init() {
    lazy.log.info("Setting and locking enterprise endpoints");

    const consoleBaseURI = await lazy.ConsoleClient.consoleBaseURI;

    const defaultBranch = Services.prefs.getDefaultBranch("");

    for (const { pref, path } of RELATIVE_CONSOLE_ENDPOINT_PREFS) {
      const url = new URL(path, consoleBaseURI).href;
      defaultBranch.setStringPref(pref, url);
      Services.prefs.lockPref(pref);
    }

    for (const pref of BASE_CONSOLE_URI_PREFS) {
      defaultBranch.setStringPref(pref, consoleBaseURI.href);
      Services.prefs.lockPref(pref);
    }
  },
};
