/* Any copyright is dedicated to the Public Domain.
https://creativecommons.org/publicdomain/zero/1.0/ */
"use strict";

/* import-globals-from ../../../../testing/xpcshell/head.js */

const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);
const { FirstStartup } = ChromeUtils.importESModule(
  "resource://gre/modules/FirstStartup.sys.mjs"
);
const { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);
const {
  DefaultWindowsLaunchOnLogin,
  DEFAULT_WINDOWS_LAUNCH_ON_LOGIN_NIMBUS_FEATURE_ID,
} = ChromeUtils.importESModule(
  "resource:///modules/DefaultWindowsLaunchOnLogin.sys.mjs"
);
const { ExperimentAPI, NimbusFeatures } = ChromeUtils.importESModule(
  "resource://nimbus/ExperimentAPI.sys.mjs"
);
const { NimbusTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/NimbusTestUtils.sys.mjs"
);
const { updateAppInfo } = ChromeUtils.importESModule(
  "resource://testing-common/AppInfo.sys.mjs"
);
const { WindowsLaunchOnLogin } = ChromeUtils.importESModule(
  "resource://gre/modules/WindowsLaunchOnLogin.sys.mjs"
);
const { MockRegistry } = ChromeUtils.importESModule(
  "resource://testing-common/MockRegistry.sys.mjs"
);

const PREF_CATEGORY_TASKS = "first-startup.category-tasks-enabled";
const CATEGORY_NAME = "first-startup-new-profile";

NimbusTestUtils.init(this);

let registry = null;
add_setup(async () => {
  // FOG needs a profile
  do_get_profile();

  registry = new MockRegistry();

  // It's expected that these keys exist
  registry.setValue(
    Ci.nsIWindowsRegKey.ROOT_KEY_CURRENT_USER,
    "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run",
    "",
    ""
  );
  registry.setValue(
    Ci.nsIWindowsRegKey.ROOT_KEY_CURRENT_USER,
    "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run",
    "",
    ""
  );

  Services.fog.initializeFOG();
  Services.fog.testResetFOG();
  updateAppInfo();

  // Delete any other first-startup-new-profile entries
  // that have been registered statically so that we're
  // just running the one here under test.
  for (let { entry } of Services.catMan.enumerateCategory(CATEGORY_NAME)) {
    if (entry != "resource:///modules/DefaultWindowsLaunchOnLogin.sys.mjs") {
      Services.catMan.deleteCategoryEntry(CATEGORY_NAME, entry, false);
    }
  }

  const { cleanup: nimbusTestCleanup } = await NimbusTestUtils.setupTest();

  registerCleanupFunction(() => {
    nimbusTestCleanup();
    registry.shutdown();
  });
});

add_task(async function test_is_firstStartupNewProfile_registered() {
  const entry = Services.catMan.getCategoryEntry(
    CATEGORY_NAME,
    "resource:///modules/DefaultWindowsLaunchOnLogin.sys.mjs"
  );
  Assert.ok(
    entry,
    "An entry should exist for resource:///modules/DefaultWindowsLaunchOnLogin.sys.mjs"
  );
  Assert.equal(
    entry,
    "DefaultWindowsLaunchOnLogin.firstStartupNewProfile",
    "Entry value should point to the `firstStartupNewProfile` method"
  );
});

// Test that Windows LaunchOnLogin is set if Nimbus says to set it
add_task(
  {
    skip_if: () =>
      !AppConstants.MOZ_NORMANDY || AppConstants.platform !== "win",
  },
  async function test_defaultWindowsLaunchOnLogin_remote_enable() {
    NimbusTestUtils.cleanupStorePrefCache();

    // Enable category tasks for first startup
    Services.prefs.setBoolPref(PREF_CATEGORY_TASKS, true);
    FirstStartup.resetForTesting();

    const firstStartupFeatureCleanup =
      await NimbusTestUtils.enrollWithFeatureConfig(
        {
          featureId: DEFAULT_WINDOWS_LAUNCH_ON_LOGIN_NIMBUS_FEATURE_ID,
          value: { enabled: true },
        },
        { isRollout: true }
      );

    // Track whether firstStartupNewProfile was called
    let sandbox = sinon.createSandbox();
    let firstStartupNewProfileSpy = sandbox.spy(
      DefaultWindowsLaunchOnLogin,
      "firstStartupNewProfile"
    );

    let submissionPromise = new Promise(resolve => {
      GleanPings.firstStartup.testBeforeNextSubmit(() => {
        Assert.equal(FirstStartup.state, FirstStartup.SUCCESS);
        resolve();
      });
    });

    // Run FirstStartup which should trigger out category hook
    FirstStartup.init(true /* newProfile */);

    await submissionPromise;

    Assert.ok(
      firstStartupNewProfileSpy.calledOnce,
      "firstStartupNewProfile should have been called"
    );

    // Check launchOnLogin has been set
    let enabled = await WindowsLaunchOnLogin.getLaunchOnLoginEnabled();
    Assert.ok(enabled, "LaunchOnLogin should be set");

    // Remove any keys for the next test
    await WindowsLaunchOnLogin.removeLaunchOnLogin();

    sandbox.restore();
    await firstStartupFeatureCleanup();
    Services.prefs.clearUserPref(PREF_CATEGORY_TASKS);
  }
);

// Check that Windows Launch on Login hasn't been set if nimbus says not to
add_task(
  {
    skip_if: () =>
      !AppConstants.MOZ_NORMANDY || AppConstants.platform !== "win",
  },
  async function test_defaultWindowsLaunchOnLogin_remote_disable() {
    NimbusTestUtils.cleanupStorePrefCache();

    // Enable category tasks for first startup
    Services.prefs.setBoolPref(PREF_CATEGORY_TASKS, true);
    FirstStartup.resetForTesting();

    const firstStartupFeatureCleanup =
      await NimbusTestUtils.enrollWithFeatureConfig(
        {
          featureId: DEFAULT_WINDOWS_LAUNCH_ON_LOGIN_NIMBUS_FEATURE_ID,
          value: { enabled: false },
        },
        { isRollout: true }
      );

    // Track whether firstStartupNewProfile was called
    let sandbox = sinon.createSandbox();
    let firstStartupNewProfileSpy = sandbox.spy(
      DefaultWindowsLaunchOnLogin,
      "firstStartupNewProfile"
    );

    let submissionPromise = new Promise(resolve => {
      GleanPings.firstStartup.testBeforeNextSubmit(() => {
        Assert.equal(FirstStartup.state, FirstStartup.SUCCESS);
        resolve();
      });
    });

    // Run FirstStartup which should trigger out category hook
    FirstStartup.init(true /* newProfile */);

    await submissionPromise;

    Assert.ok(
      firstStartupNewProfileSpy.calledOnce,
      "firstStartupNewProfile should have been called"
    );

    // Check launchOnLogin has been set
    let enabled = await WindowsLaunchOnLogin.getLaunchOnLoginEnabled();
    Assert.ok(!enabled, "LaunchOnLogin should not be set");

    sandbox.restore();
    await firstStartupFeatureCleanup();
    Services.prefs.clearUserPref(PREF_CATEGORY_TASKS);
  }
);
