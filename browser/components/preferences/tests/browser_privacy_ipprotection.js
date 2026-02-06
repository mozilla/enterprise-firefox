/* Any copyright is dedicated to the Public Domain.
 * https://creativecommons.org/publicdomain/zero/1.0/ */

// This file tests the Privacy pane's Firefox VPN UI.

"use strict";

const lazy = {};

const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);

ChromeUtils.defineESModuleGetters(lazy, {
  SpecialMessageActions:
    "resource://messaging-system/lib/SpecialMessageActions.sys.mjs",
});

const FEATURE_PREF = "browser.ipProtection.enabled";
const SITE_EXCEPTIONS_FEATURE_PREF =
  "browser.ipProtection.features.siteExceptions";
const AUTOSTART_FEATURE_ENABLED_PREF =
  "browser.ipProtection.features.autoStart";
const BANDWIDTH_FEATURE_ENABLED_PREF = "browser.ipProtection.bandwidth.enabled";
const AUTOSTART_PREF = "browser.ipProtection.autoStartEnabled";
const AUTOSTART_PRIVATE_PREF = "browser.ipProtection.autoStartPrivateEnabled";
const ONBOARDING_MESSAGE_MASK_PREF =
  "browser.ipProtection.onboardingMessageMask";
const ENTITLEMENT_CACHE_PREF = "browser.ipProtection.entitlementCache";

async function setupVpnPrefs({
  feature = false,
  siteExceptions = false,
  autostartFeatureEnabled = false,
  bandwidth = false,
  autostart = false,
  autostartprivate = false,
  entitlementCache = undefined,
}) {
  let prefs = [
    [FEATURE_PREF, feature],
    [SITE_EXCEPTIONS_FEATURE_PREF, siteExceptions],
    [AUTOSTART_FEATURE_ENABLED_PREF, autostartFeatureEnabled],
    [BANDWIDTH_FEATURE_ENABLED_PREF, bandwidth],
    [AUTOSTART_PREF, autostart],
    [AUTOSTART_PRIVATE_PREF, autostartprivate],
  ];

  if (entitlementCache !== undefined) {
    prefs.push([ENTITLEMENT_CACHE_PREF, entitlementCache]);
  }

  return SpecialPowers.pushPrefEnv({
    set: prefs,
  });
}

function testSettingsGroupVisible(browser) {
  let settingGroup = browser.contentDocument.querySelector(
    `setting-group[groupid="ipprotection"]`
  );
  is_element_visible(settingGroup, "ipprotection setting group is shown");

  return settingGroup;
}

// Test the section is hidden on page load if the feature pref is disabled.
add_task(
  async function test_section_removed_when_set_to_ineligible_experiment_pref() {
    await setupVpnPrefs({ feature: false });

    await BrowserTestUtils.withNewTab(
      { gBrowser, url: "about:preferences#privacy" },
      async function (browser) {
        let settingGroup = browser.contentDocument.querySelector(
          `setting-group[groupid="ipprotection"]`
        );
        is_element_hidden(settingGroup, "ipprotection setting group is hidden");
      }
    );

    await SpecialPowers.popPrefEnv();
  }
);

// Test the section is shown on page load if the feature pref is enabled
add_task(
  async function test_section_shown_when_set_to_eligible_experiment_pref() {
    await setupVpnPrefs({ feature: true });

    await BrowserTestUtils.withNewTab(
      { gBrowser, url: "about:preferences#privacy" },
      async function (browser) {
        testSettingsGroupVisible(browser);
      }
    );
  }
);

// Test the site exceptions controls load correctly.
add_task(async function test_exceptions_settings() {
  await setupVpnPrefs({ feature: true, siteExceptions: true });

  await BrowserTestUtils.withNewTab(
    { gBrowser, url: "about:preferences#privacy" },
    async function (browser) {
      let settingGroup = testSettingsGroupVisible(browser);
      let siteExceptionsGroup = settingGroup?.querySelector(
        "#ipProtectionExceptions"
      );
      is_element_visible(siteExceptionsGroup, "Site exceptions group is shown");

      let exceptionAllListButton = siteExceptionsGroup?.querySelector(
        "#ipProtectionExceptionAllListButton"
      );
      is_element_visible(
        exceptionAllListButton,
        "Button for list of exclusions is shown"
      );
    }
  );
});

// Test that we show the "Add" button in the site exceptions permission dialog
// and correctly add site exclusions.
add_task(async function test_exclusions_add_button() {
  const PERM_NAME = "ipp-vpn";
  await setupVpnPrefs({ feature: "beta", siteExceptions: true });

  await BrowserTestUtils.withNewTab(
    { gBrowser, url: "about:preferences#privacy" },
    async function (browser) {
      let settingGroup = testSettingsGroupVisible(browser);
      let siteExceptionsGroup = settingGroup?.querySelector(
        "#ipProtectionExceptions"
      );
      let exceptionAllListButton = siteExceptionsGroup?.querySelector(
        "#ipProtectionExceptionAllListButton"
      );
      is_element_visible(
        exceptionAllListButton,
        "Button for list of exclusions is shown"
      );

      // Clear ipp-vpn to start with 0 exclusions
      Services.perms.removeByType(PERM_NAME);

      // Let's load the dialog
      let promiseSubDialogLoaded = promiseLoadSubDialog(
        "chrome://browser/content/preferences/dialogs/permissions.xhtml"
      );

      exceptionAllListButton.click();

      const win = await promiseSubDialogLoaded;

      let addButton = win.document.getElementById("btnAdd");
      Assert.ok(addButton, "Add button exists");
      Assert.ok(BrowserTestUtils.isVisible(addButton), "Add button is visible");
      Assert.ok(addButton.disabled, "Add button is disabled");

      // Now let's click the Add button to add a new exclusion
      let permissionsBox = win.document.getElementById("permissionsBox");
      let siteListUpdatedPromise = BrowserTestUtils.waitForMutationCondition(
        permissionsBox,
        { subtree: true, childList: true },
        () => {
          return permissionsBox.children.length;
        }
      );

      // Set up a mock url input value
      let urlField = win.document.getElementById("url");
      Assert.ok(urlField, "Dialog url field exists");
      const site1 = "https://example.com";
      urlField.focus();

      EventUtils.sendString(site1, win);
      Assert.ok(!addButton.disabled, "Add button is enabled");

      addButton.click();

      await siteListUpdatedPromise;

      permissionsBox = win.document.getElementById("permissionsBox");
      Assert.equal(
        permissionsBox.children.length,
        1,
        "Should have 1 site listed as an exclusion"
      );

      let shownSite1 = permissionsBox.children[0];
      Assert.equal(
        shownSite1.getAttribute("origin"),
        site1,
        "Should match inputted site in the list of sites"
      );

      // Apply the changes
      let saveButton = win.document.querySelector("dialog").getButton("accept");
      Assert.ok(saveButton, "Save button is shown");

      saveButton.click();

      let exclusions = Services.perms.getAllByTypes([PERM_NAME]);
      Assert.equal(
        exclusions.length,
        1,
        "Should have 1 exclusion after pressing the Add button"
      );
      Assert.equal(
        exclusions[0]?.principal.siteOrigin,
        site1,
        "Should match the inputted site"
      );

      // Clean up
      Services.perms.removeByType(PERM_NAME);
      Services.prefs.clearUserPref(ONBOARDING_MESSAGE_MASK_PREF);
    }
  );
});

// Test that we show the correct number of site exclusions
add_task(async function test_exclusions_count() {
  const PERM_NAME = "ipp-vpn";
  await setupVpnPrefs({ feature: "beta", siteExceptions: true });

  await BrowserTestUtils.withNewTab(
    { gBrowser, url: "about:preferences#privacy" },
    async function (browser) {
      let settingGroup = browser.contentDocument.querySelector(
        `setting-group[groupid="ipprotection"]`
      );
      is_element_visible(settingGroup, "ipprotection setting group is shown");

      let siteExceptionsGroup = settingGroup?.querySelector(
        "#ipProtectionExceptions"
      );
      is_element_visible(siteExceptionsGroup, "Site exceptions group is shown");

      let exceptionAllListButton = siteExceptionsGroup?.querySelector(
        "#ipProtectionExceptionAllListButton"
      );
      is_element_visible(
        exceptionAllListButton,
        "Button for list of exclusions is shown"
      );

      let sitesCountUpdatedPromise = BrowserTestUtils.waitForMutationCondition(
        exceptionAllListButton,
        { attributes: true, attributeFilter: ["data-l10n-args"] },
        () => {
          let args = exceptionAllListButton.getAttribute("data-l10n-args");
          return args && JSON.parse(args)?.count === 0;
        }
      );

      // Clear ipp-vpn to start with 0 exclusions
      Services.perms.removeByType(PERM_NAME);

      await sitesCountUpdatedPromise;

      Assert.ok(true, "Should show 0 exclusions initially");

      // Now test with 1 exclusion
      sitesCountUpdatedPromise = BrowserTestUtils.waitForMutationCondition(
        exceptionAllListButton,
        { attributes: true, attributeFilter: ["data-l10n-args"] },
        () => {
          let args = exceptionAllListButton.getAttribute("data-l10n-args");
          return args && JSON.parse(args)?.count === 1;
        }
      );
      let site1 = "https://example.com";
      let principal1 =
        Services.scriptSecurityManager.createContentPrincipalFromOrigin(site1);
      Services.perms.addFromPrincipal(
        principal1,
        PERM_NAME,
        Services.perms.DENY_ACTION
      );

      await sitesCountUpdatedPromise;

      Assert.ok(true, "Should show 1 exclusion after adding the first site");

      // Now test with 2 exclusions
      sitesCountUpdatedPromise = BrowserTestUtils.waitForMutationCondition(
        exceptionAllListButton,
        { attributes: true, attributeFilter: ["data-l10n-args"] },
        () => {
          let args = exceptionAllListButton.getAttribute("data-l10n-args");
          return args && JSON.parse(args)?.count === 2;
        }
      );
      let site2 = "https://example.org";
      let principal2 =
        Services.scriptSecurityManager.createContentPrincipalFromOrigin(site2);
      Services.perms.addFromPrincipal(
        principal2,
        PERM_NAME,
        Services.perms.DENY_ACTION
      );

      await sitesCountUpdatedPromise;

      Assert.ok(true, "Should show 2 exclusions after adding the second site");

      // Clean up
      Services.perms.removeByType(PERM_NAME);
      Services.prefs.clearUserPref(ONBOARDING_MESSAGE_MASK_PREF);
    }
  );
});

// Test that autostart checkboxes exist and map to the correct preferences
add_task(async function test_autostart_checkboxes() {
  await setupVpnPrefs({
    feature: true,
    autostartFeatureEnabled: true,
    autostart: true,
    autostartprivate: true,
  });

  await BrowserTestUtils.withNewTab(
    { gBrowser, url: "about:preferences#privacy" },
    async function (browser) {
      let settingGroup = testSettingsGroupVisible(browser);
      let autoStartSettings = settingGroup?.querySelector(
        "#ipProtectionAutoStart"
      );
      is_element_visible(
        autoStartSettings,
        "autoStart settings group is shown"
      );

      let autoStartCheckbox = autoStartSettings?.querySelector(
        "#ipProtectionAutoStartCheckbox"
      );
      let autoStartPrivateCheckbox = autoStartSettings?.querySelector(
        "#ipProtectionAutoStartPrivateCheckbox"
      );

      Assert.ok(
        autoStartCheckbox.checked,
        "Autostart checkbox should be checked"
      );
      Assert.ok(
        autoStartPrivateCheckbox.checked,
        "Autostart in private browsing checkbox should be checked"
      );
    }
  );
});

// Test that additional links exist
add_task(async function test_additional_links() {
  await setupVpnPrefs({
    feature: true,
  });

  await BrowserTestUtils.withNewTab(
    { gBrowser, url: "about:preferences#privacy" },
    async function (browser) {
      let settingGroup = testSettingsGroupVisible(browser);
      let ipProtectionLinks = settingGroup?.querySelector("#ipProtectionLinks");
      is_element_visible(
        ipProtectionLinks,
        "VPN upgrade link section is shown"
      );
    }
  );
});

// Test that the "not opted in" section is shown when entitlementCache is "null"
add_task(async function test_not_opted_in_section_visible_when_null() {
  await setupVpnPrefs({
    feature: true,
    entitlementCache: "null",
  });

  await BrowserTestUtils.withNewTab(
    { gBrowser, url: "about:preferences#privacy" },
    async function (browser) {
      let settingGroup = testSettingsGroupVisible(browser);
      let notOptedInSection = settingGroup?.querySelector(
        "#ipProtectionNotOptedInSection"
      );
      is_element_visible(
        notOptedInSection,
        "Not opted in section is shown when entitlementCache is null"
      );

      let getStartedButton = settingGroup?.querySelector("#getStartedButton");
      is_element_visible(
        getStartedButton,
        "Get started button is shown when entitlementCache is null"
      );
    }
  );
});

// Test that clicking the "Get started" button calls fxaSignInFlow
add_task(async function test_get_started_button() {
  let sandbox = sinon.createSandbox();
  sandbox
    .stub(lazy.SpecialMessageActions, "fxaSignInFlow")
    .callsFake(async function () {
      return true;
    });

  await setupVpnPrefs({
    feature: true,
    entitlementCache: "null",
  });

  await BrowserTestUtils.withNewTab(
    { gBrowser, url: "about:preferences#privacy" },
    async function (browser) {
      let settingGroup = testSettingsGroupVisible(browser);
      let getStartedButton = settingGroup?.querySelector("#getStartedButton");
      is_element_visible(
        getStartedButton,
        "Get started button is shown when entitlementCache is null"
      );

      getStartedButton.click();

      Assert.ok(
        lazy.SpecialMessageActions.fxaSignInFlow.calledOnce,
        "fxaSignInFlow should be called once when Get started button is clicked"
      );
    }
  );

  sandbox.restore();
});

// Test that the "not opted in" section is hidden when entitlementCache has a value
add_task(async function test_not_opted_in_section_hidden_when_opted_in() {
  await setupVpnPrefs({
    feature: true,
    entitlementCache: '{"some":"data"}',
  });

  await BrowserTestUtils.withNewTab(
    { gBrowser, url: "about:preferences#privacy" },
    async function (browser) {
      let settingGroup = testSettingsGroupVisible(browser);
      let notOptedInSection = settingGroup?.querySelector(
        "#ipProtectionNotOptedInSection"
      );
      is_element_hidden(
        notOptedInSection,
        "Not opted in section is hidden when entitlementCache has a value"
      );

      let getStartedButton = settingGroup?.querySelector("#getStartedButton");
      is_element_hidden(
        getStartedButton,
        "Get started button is hidden when entitlementCache has a value"
      );
    }
  );
});

// Test that VPN sections are hidden when entitlementCache is "null"
add_task(async function test_vpn_sections_hidden_when_not_opted_in() {
  await setupVpnPrefs({
    feature: true,
    siteExceptions: true,
    autostartFeatureEnabled: true,
    entitlementCache: "null",
  });

  await BrowserTestUtils.withNewTab(
    { gBrowser, url: "about:preferences#privacy" },
    async function (browser) {
      let settingGroup = testSettingsGroupVisible(browser);

      let siteExceptionsGroup = settingGroup?.querySelector(
        "#ipProtectionExceptions"
      );
      is_element_hidden(
        siteExceptionsGroup,
        "Site exceptions group is hidden when entitlementCache is null"
      );

      let autoStartSettings = settingGroup?.querySelector(
        "#ipProtectionAutoStart"
      );
      is_element_hidden(
        autoStartSettings,
        "Autostart settings group is hidden when entitlementCache is null"
      );

      let ipProtectionLinks = settingGroup?.querySelector("#ipProtectionLinks");
      is_element_hidden(
        ipProtectionLinks,
        "VPN links section is hidden when entitlementCache is null"
      );

      let bandwidthSettings = settingGroup?.querySelector(
        "#ipProtectionBandwidth"
      );
      is_element_hidden(
        bandwidthSettings,
        "Bandwidth settings are hidden when entitlementCache is null"
      );
    }
  );
});

// Test that VPN sections are shown when entitlementCache has a value
add_task(async function test_vpn_sections_shown_when_opted_in() {
  await setupVpnPrefs({
    feature: true,
    siteExceptions: true,
    autostartFeatureEnabled: true,
    entitlementCache: '{"some":"data"}',
  });

  await BrowserTestUtils.withNewTab(
    { gBrowser, url: "about:preferences#privacy" },
    async function (browser) {
      let settingGroup = testSettingsGroupVisible(browser);

      let siteExceptionsGroup = settingGroup?.querySelector(
        "#ipProtectionExceptions"
      );
      is_element_visible(
        siteExceptionsGroup,
        "Site exceptions group is shown when entitlementCache has a value"
      );

      let autoStartSettings = settingGroup?.querySelector(
        "#ipProtectionAutoStart"
      );
      is_element_visible(
        autoStartSettings,
        "Autostart settings group is shown when entitlementCache has a value"
      );

      let ipProtectionLinks = settingGroup?.querySelector("#ipProtectionLinks");
      is_element_visible(
        ipProtectionLinks,
        "VPN links section is shown when entitlementCache has a value"
      );

      let bandwidthSettings = settingGroup?.querySelector(
        "#ipProtectionBandwidth"
      );
      is_element_hidden(
        bandwidthSettings,
        "Bandwidth settings are hidden when bandwidth feature is not enabled"
      );
    }
  );
});
