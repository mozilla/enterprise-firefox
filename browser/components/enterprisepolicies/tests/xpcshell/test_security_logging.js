/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { SecurityLoggingPolicy } = ChromeUtils.importESModule(
  "resource:///modules/policies/SecurityLoggingPolicy.sys.mjs"
);
const { PoliciesPrefTracker } = ChromeUtils.importESModule(
  "resource://testing-common/EnterprisePolicyTesting.sys.mjs"
);

const SECURITY_LOGGING_PREFS = {
  "extensions.enterprise.telemetry.addonInstall.enabled": true,
  "browser.policies.enterprise.telemetry.blocklistDomainBrowsed.enabled": true,
  "browser.policies.enterprise.telemetry.blocklistDomainBrowsed.urlLogging":
    "domain",
  "browser.download.enterprise.telemetry.enabled": true,
  "browser.download.enterprise.telemetry.urlLogging": "full",
  "browser.download.enterprise.telemetry.fileLogging": "metadata",
  "print.enterprise.telemetry.printPage.enabled": false,
  "print.enterprise.telemetry.printPage.urlLogging": "none",
  "browser.safebrowsing.enterprise.telemetry.unsafeDownload.enabled": true,
  "browser.safebrowsing.enterprise.telemetry.unsafeDownload.urlLogging":
    "domain",
  "browser.safebrowsing.enterprise.telemetry.unsafeSiteVisit.enabled": true,
  "browser.safebrowsing.enterprise.telemetry.unsafeSiteVisit.urlLogging":
    "full",
};

add_setup(function () {
  // Restores every pref an engine-applied policy set once the engine is set up
  // again, so the engine-based tasks below do not depend on their order.
  PoliciesPrefTracker.start();
  registerCleanupFunction(() => PoliciesPrefTracker.stop());
});

// Runs first: the policy helpers record a pref's pre-policy state only once,
// so this direct apply() has to see the prefs before any engine task touched
// them.
add_task(async function test_apply_and_remove() {
  const printEnabled = "print.enterprise.telemetry.printPage.enabled";
  const downloadPrefs = [
    "browser.download.enterprise.telemetry.enabled",
    "browser.download.enterprise.telemetry.urlLogging",
    "browser.download.enterprise.telemetry.fileLogging",
  ];
  const unsafeSitePrefs = [
    "browser.safebrowsing.enterprise.telemetry.unsafeSiteVisit.enabled",
    "browser.safebrowsing.enterprise.telemetry.unsafeSiteVisit.urlLogging",
  ];
  // A lock from another administrative source on an event the policy does not
  // configure, and a user pref on a setting the policy leaves out.
  Services.prefs.getDefaultBranch("").setBoolPref(printEnabled, true);
  Services.prefs.lockPref(printEnabled);
  Services.prefs.setCharPref(downloadPrefs[1], "none");

  const param = { Download: { Enabled: true }, UnsafeSiteVisit: {} };
  try {
    try {
      SecurityLoggingPolicy.apply(param);
      checkLockedPref(downloadPrefs[0], true);
      checkLockedPref(downloadPrefs[1], "full");
      checkLockedPref(downloadPrefs[2], "full");
      // An event configured without any setting is locked off, with full
      // logging.
      checkLockedPref(unsafeSitePrefs[0], false);
      checkLockedPref(unsafeSitePrefs[1], "full");
      checkLockedPref(printEnabled, true);
    } finally {
      SecurityLoggingPolicy.remove(param);
    }

    for (const pref of [...downloadPrefs, ...unsafeSitePrefs]) {
      Assert.ok(
        !Services.prefs.prefHasDefaultValue(pref),
        `Pref ${pref} has no default value once the policy is removed`
      );
      Assert.ok(!Preferences.locked(pref), `Pref ${pref} is unlocked again`);
    }
    checkUserPref(downloadPrefs[1], "none");
    checkLockedPref(printEnabled, true);
  } finally {
    Services.prefs.clearUserPref(downloadPrefs[1]);
    Services.prefs.unlockPref(printEnabled);
    Services.prefs.getDefaultBranch("").deleteBranch(printEnabled);
  }
});

add_task(async function test_unspecified_settings_of_configured_events() {
  await setupPolicyEngineWithJson({
    policies: {
      SecurityLogging: {
        Download: { Enabled: true },
        UnsafeSiteVisit: { UrlLogging: "domain" },
      },
    },
  });

  // The settings a configured event leaves out are locked to their defaults,
  // so a user pref can neither weaken an event the administrator turned on nor
  // turn on one the administrator configured but left disabled.
  checkLockedPref("browser.download.enterprise.telemetry.enabled", true);
  checkLockedPref("browser.download.enterprise.telemetry.urlLogging", "full");
  checkLockedPref("browser.download.enterprise.telemetry.fileLogging", "full");
  checkLockedPref(
    "browser.safebrowsing.enterprise.telemetry.unsafeSiteVisit.enabled",
    false
  );
  checkLockedPref(
    "browser.safebrowsing.enterprise.telemetry.unsafeSiteVisit.urlLogging",
    "domain"
  );

  // Events the policy does not configure are left alone.
  for (const pref of [
    "print.enterprise.telemetry.printPage.enabled",
    "print.enterprise.telemetry.printPage.urlLogging",
  ]) {
    checkUnsetPref(pref);
    Assert.ok(!Preferences.locked(pref), `Pref ${pref} is not locked`);
  }
});

add_task(async function test_all_events_configured_through_policy_engine() {
  await setupPolicyEngineWithJson({
    policies: {
      SecurityLogging: {
        AddonInstall: { Enabled: true },
        BlocklistDomainBrowsed: { Enabled: true, UrlLogging: "domain" },
        Download: {
          Enabled: true,
          UrlLogging: "full",
          FileLogging: "metadata",
        },
        PrintPage: { Enabled: false, UrlLogging: "none" },
        UnsafeDownload: { Enabled: true, UrlLogging: "domain" },
        UnsafeSiteVisit: { Enabled: true, UrlLogging: "full" },
      },
    },
  });

  for (const [pref, value] of Object.entries(SECURITY_LOGGING_PREFS)) {
    checkLockedPref(pref, value);
  }
});
