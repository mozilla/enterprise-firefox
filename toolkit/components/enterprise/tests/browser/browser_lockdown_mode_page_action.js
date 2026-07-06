/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { EnterprisePolicyTesting } = ChromeUtils.importESModule(
  "resource://testing-common/EnterprisePolicyTesting.sys.mjs"
);

const LOCKED_URL = "https://example.com/";
const UNLOCKED_URL = "https://example.org/";

const SITE_POLICIES = {
  policies: {
    SitePolicies: [
      {
        Match: ["*.example.com"],
        Policies: { DisableJit: true },
      },
    ],
  },
};

function getLockdownUrlbarButton() {
  return document.getElementById("lockdown-mode-button");
}

async function setupWithSitePolicies() {
  await EnterprisePolicyTesting.setupPolicyEngineWithJson(SITE_POLICIES);
}

add_setup(async function () {
  // The enterprise build ships a distribution/policies.json that takes
  // priority over the alternatePath set by setupPolicyEngineWithJson.
  // Setting perUserDir redirects policy lookup to XREUserRunTimeDir where
  // no policies.json exists, enabling alternatePath to work.
  Services.prefs.setBoolPref("toolkit.policies.perUserDir", true);
  await EnterprisePolicyTesting.setupPolicyEngineWithJson({ policies: {} });
});

registerCleanupFunction(async () => {
  await EnterprisePolicyTesting.setupPolicyEngineWithJson({ policies: {} });
  Services.prefs.clearUserPref("toolkit.policies.perUserDir");
});

add_task(async function test_button_hidden_without_site_policies() {
  await EnterprisePolicyTesting.setupPolicyEngineWithJson({ policies: {} });

  await BrowserTestUtils.withNewTab(LOCKED_URL, async () => {
    Assert.ok(
      getLockdownUrlbarButton().hidden,
      "Lockdown mode button should be hidden without SitePolicies"
    );
  });
});

add_task(async function test_button_visible_with_site_policies() {
  await setupWithSitePolicies();

  await BrowserTestUtils.withNewTab(LOCKED_URL, async () => {
    Assert.ok(
      !getLockdownUrlbarButton().hidden,
      "Lockdown mode button should be visible with SitePolicies on a locked-down page"
    );
  });
});

add_task(async function test_button_hidden_on_non_locked_down_page() {
  await setupWithSitePolicies();

  await BrowserTestUtils.withNewTab(UNLOCKED_URL, async () => {
    Assert.ok(
      getLockdownUrlbarButton().hidden,
      "Urlbar button should be hidden on a page without lockdown policy"
    );
  });
});

add_task(async function test_button_toggles_with_navigation() {
  await setupWithSitePolicies();

  await BrowserTestUtils.withNewTab(LOCKED_URL, async browser => {
    Assert.ok(
      !getLockdownUrlbarButton().hidden,
      "Urlbar button should be visible on a locked-down page"
    );

    let locationChange = BrowserTestUtils.waitForLocationChange(
      gBrowser,
      UNLOCKED_URL
    );
    BrowserTestUtils.startLoadingURIString(browser, UNLOCKED_URL);
    await locationChange;

    Assert.ok(
      getLockdownUrlbarButton().hidden,
      "Urlbar button should be hidden after navigating to a non-locked-down page"
    );

    locationChange = BrowserTestUtils.waitForLocationChange(
      gBrowser,
      LOCKED_URL
    );
    BrowserTestUtils.startLoadingURIString(browser, LOCKED_URL);
    await locationChange;

    Assert.ok(
      !getLockdownUrlbarButton().hidden,
      "Urlbar button should reappear after navigating back to a locked-down page"
    );
  });
});

add_task(async function test_button_hidden_when_switching_to_non_locked_tab() {
  await setupWithSitePolicies();

  let lockedTab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    LOCKED_URL
  );
  Assert.ok(
    !getLockdownUrlbarButton().hidden,
    "Urlbar button should be visible on a locked-down page"
  );

  let unlockedTab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    UNLOCKED_URL
  );
  Assert.ok(
    getLockdownUrlbarButton().hidden,
    "Urlbar button should be hidden after switching to a non-locked-down tab"
  );

  await BrowserTestUtils.switchTab(gBrowser, lockedTab);
  Assert.ok(
    !getLockdownUrlbarButton().hidden,
    "Urlbar button should be visible after switching back to locked-down tab"
  );

  BrowserTestUtils.removeTab(lockedTab);
  BrowserTestUtils.removeTab(unlockedTab);
});

add_task(async function test_button_position() {
  await setupWithSitePolicies();

  await BrowserTestUtils.withNewTab(LOCKED_URL, async () => {
    const urlbarButton = getLockdownUrlbarButton();
    Assert.ok(!urlbarButton.hidden, "Urlbar button should be visible");

    Assert.equal(
      urlbarButton.parentElement.id,
      "enterprise-urlbar-actions",
      "Urlbar button should be inside the enterprise urlbar actions container"
    );

    const enterpriseActions = document.getElementById(
      "enterprise-urlbar-actions"
    );
    Assert.equal(
      enterpriseActions.parentElement.id,
      "page-action-buttons",
      "Enterprise urlbar actions container should be inside page-action-buttons"
    );
    Assert.equal(
      enterpriseActions.nextElementSibling?.id,
      "pageActionButton",
      "Enterprise urlbar actions container should be positioned just before the page action button"
    );
  });
});

add_task(async function test_subview_content() {
  await setupWithSitePolicies();

  await BrowserTestUtils.withNewTab(LOCKED_URL, async () => {
    const urlbarButton = getLockdownUrlbarButton();
    Assert.ok(!urlbarButton.hidden, "Urlbar button should be visible");

    // showSubView creates the temp panel synchronously before opening it.
    EventUtils.synthesizeMouseAtCenter(urlbarButton, {});

    let tempPanel = document.getElementById("customizationui-widget-panel");
    await BrowserTestUtils.waitForEvent(tempPanel, "popupshown");

    let subview = tempPanel.querySelector("#panelUI-lockdown-mode");
    Assert.notEqual(subview, null, "Lockdown mode subview should be present");

    Assert.notEqual(
      subview.querySelector("[data-l10n-id='lockdown-mode-popup-header']"),
      null,
      "Subview should contain the header element"
    );

    Assert.notEqual(
      subview.querySelector("[data-l10n-id='lockdown-mode-popup-message']"),
      null,
      "Subview should contain the message element"
    );

    let panelHidden = BrowserTestUtils.waitForEvent(tempPanel, "popuphidden");
    PanelMultiView.hidePopup(tempPanel);
    await panelHidden;
  });
});
