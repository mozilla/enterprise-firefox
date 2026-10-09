/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const {
  EnterprisePingCollector,
  EnterprisePolicyTesting,
  PoliciesPrefTracker,
} = ChromeUtils.importESModule(
  "resource://testing-common/EnterprisePolicyTesting.sys.mjs"
);

const PREF_ENABLED = "extensions.enterprise.telemetry.addonInstall.enabled";

/**
 * Installs and then unloads an extension, returning the collector that saw the
 * enterprise pings submitted meanwhile.
 *
 * @param {string} id The extension id.
 * @returns {Promise<EnterprisePingCollector>}
 */
async function installExtension(id) {
  Services.fog.testResetFOG();
  using collector = new EnterprisePingCollector(
    Glean.addonsManager.installComplete
  );
  const extension = ExtensionTestUtils.loadExtension({
    manifest: {
      browser_specific_settings: { gecko: { id } },
    },
    useAddonManager: "permanent",
    amInstallTelemetryInfo: {
      source: "about:addons",
      method: "install-from-file",
    },
  });

  await extension.startup();
  await extension.unload();
  return collector;
}

add_setup(async function () {
  do_get_profile();
  Services.fog.initializeFOG();
  Services.policies; // eslint-disable-line no-unused-expressions
  PoliciesPrefTracker.start();
  createAppInfo("xpcshell@tests.mozilla.org", "XPCShell", "1", "1.9.2");
  await promiseStartupManager();

  registerCleanupFunction(async () => {
    await EnterprisePolicyTesting.setupPolicyEngineWithJson("");
    PoliciesPrefTracker.stop();
    await promiseShutdownManager();
  });
});

add_task(async function test_addon_install_telemetry_policy() {
  await EnterprisePolicyTesting.setupPolicyEngineWithJson({
    policies: {
      SecurityLogging: { AddonInstall: { Enabled: true } },
    },
  });

  EnterprisePolicyTesting.checkPolicyPref(PREF_ENABLED, true, true);
  let collector = await installExtension("enabled@example.com");
  Assert.equal(
    collector.events.length,
    1,
    "the enabled policy records an installation"
  );

  // The pref that once let tests turn submission off must not affect it.
  Services.prefs.setBoolPref(
    "extensions.enterprise.telemetry.testing.disableSubmit",
    true
  );
  try {
    collector = await installExtension("inert@example.com");
    Assert.equal(
      collector.submitCount,
      1,
      "the ping is submitted regardless of the pref"
    );
  } finally {
    Services.prefs.clearUserPref(
      "extensions.enterprise.telemetry.testing.disableSubmit"
    );
  }

  await EnterprisePolicyTesting.setupPolicyEngineWithJson({
    policies: {
      SecurityLogging: { AddonInstall: { Enabled: false } },
    },
  });

  EnterprisePolicyTesting.checkPolicyPref(PREF_ENABLED, false, true);
  collector = await installExtension("disabled@example.com");
  collector.assertNothingRecorded(
    "the disabled policy suppresses installation telemetry"
  );

  await EnterprisePolicyTesting.setupPolicyEngineWithJson("");

  Assert.ok(
    !Services.prefs.prefIsLocked(PREF_ENABLED),
    "the preference is unlocked"
  );
  collector = await installExtension("default@example.com");
  collector.assertNothingRecorded(
    "removing the policy restores the disabled-by-default collection"
  );
});
