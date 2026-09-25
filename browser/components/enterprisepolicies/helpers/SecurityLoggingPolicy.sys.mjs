/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  PoliciesUtils: "resource://gre/modules/PoliciesHelpers.sys.mjs",
});

const SECURITY_LOGGING_PREFS = {
  AddonInstall: {
    Enabled: "extensions.enterprise.telemetry.addonInstall.enabled",
  },
  BlocklistDomainBrowsed: {
    Enabled:
      "browser.policies.enterprise.telemetry.blocklistDomainBrowsed.enabled",
    UrlLogging:
      "browser.policies.enterprise.telemetry.blocklistDomainBrowsed.urlLogging",
  },
  Download: {
    Enabled: "browser.download.enterprise.telemetry.enabled",
    UrlLogging: "browser.download.enterprise.telemetry.urlLogging",
    FileLogging: "browser.download.enterprise.telemetry.fileLogging",
  },
  PrintPage: {
    Enabled: "print.enterprise.telemetry.printPage.enabled",
    UrlLogging: "print.enterprise.telemetry.printPage.urlLogging",
  },
  UnsafeDownload: {
    Enabled: "browser.safebrowsing.enterprise.telemetry.unsafeDownload.enabled",
    UrlLogging:
      "browser.safebrowsing.enterprise.telemetry.unsafeDownload.urlLogging",
  },
  UnsafeSiteVisit: {
    Enabled:
      "browser.safebrowsing.enterprise.telemetry.unsafeSiteVisit.enabled",
    UrlLogging:
      "browser.safebrowsing.enterprise.telemetry.unsafeSiteVisit.urlLogging",
  },
};

// The settings a configured event leaves out are locked to these defaults, which
// are what each recorder assumes when its pref is unset, so no user pref can
// alter any part of an event the administrator controls.
const SETTING_DEFAULTS = {
  Enabled: false,
  UrlLogging: "full",
  FileLogging: "full",
};

function forEachSetting(param, callback) {
  for (const [event, settings] of Object.entries(SECURITY_LOGGING_PREFS)) {
    const eventParam = param?.[event];
    if (!eventParam) {
      continue;
    }
    for (const [setting, pref] of Object.entries(settings)) {
      callback(pref, eventParam[setting] ?? SETTING_DEFAULTS[setting]);
    }
  }
}

export const SecurityLoggingPolicy = {
  apply(param) {
    forEachSetting(param, (pref, value) =>
      lazy.PoliciesUtils.setAndLockPref(pref, value)
    );
  },

  remove(oldParam) {
    forEachSetting(oldParam, pref =>
      lazy.PoliciesUtils.unsetAndUnlockPref(pref)
    );
  },
};
