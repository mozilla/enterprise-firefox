/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { EnterprisePolicyTesting } = ChromeUtils.importESModule(
  "resource://testing-common/EnterprisePolicyTesting.sys.mjs"
);
const { SITE_PROTECTIONS, SitePoliciesButton } = ChromeUtils.importESModule(
  "moz-src:///browser/components/enterprise/SitePoliciesButton.sys.mjs"
);
const { schema } = ChromeUtils.importESModule(
  "resource:///modules/policies/schema.sys.mjs"
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

function getLockdownUrlbarButton(win = window) {
  return win.document.getElementById("lockdown-mode-button");
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
      "share-button",
      "Enterprise urlbar actions container should be positioned just before the share button"
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

async function openMainView(win = window) {
  EventUtils.synthesizeMouseAtCenter(getLockdownUrlbarButton(win), {}, win);
  let tempPanel = win.document.getElementById("customizationui-widget-panel");
  await BrowserTestUtils.waitForEvent(tempPanel, "popupshown");
  return tempPanel;
}

async function openDetailsSubview(win = window) {
  let tempPanel = await openMainView(win);

  let detailsView = win.document.getElementById(
    "panelUI-lockdown-mode-details"
  );
  let viewShown = BrowserTestUtils.waitForEvent(detailsView, "ViewShown");
  tempPanel.querySelector("#lockdown-mode-details-button").click();
  await viewShown;

  return { tempPanel, detailsView };
}

async function closePanel(tempPanel) {
  let panelHidden = BrowserTestUtils.waitForEvent(tempPanel, "popuphidden");
  tempPanel.documentGlobal.PanelMultiView.hidePopup(tempPanel);
  await panelHidden;
}

function getListedPolicies(detailsView) {
  return Array.from(
    detailsView.querySelectorAll(".lockdown-mode-protection-name"),
    node => node.textContent
  );
}

add_task(async function test_details_subview_lists_applied_protections() {
  await EnterprisePolicyTesting.setupPolicyEngineWithJson({
    policies: {
      SitePolicies: [
        {
          Match: ["*.example.com"],
          Policies: { DisableJit: true, DisableServiceWorkers: true },
        },
        {
          Match: ["*.example.com"],
          Policies: { DisableJit: false, HttpsOnly: true },
        },
        {
          Match: ["*.example.org"],
          Policies: { HttpsOnly: false },
        },
      ],
    },
  });

  await BrowserTestUtils.withNewTab(LOCKED_URL, async () => {
    let { tempPanel, detailsView } = await openDetailsSubview();

    Assert.equal(
      tempPanel.querySelector("#lockdown-mode-details-count").textContent,
      "3",
      "The details row should show how many protections apply"
    );
    Assert.ok(
      detailsView.querySelector(".panel-header .subviewbutton-back"),
      "Details subview should have a back button"
    );
    Assert.deepEqual(
      getListedPolicies(detailsView),
      ["HttpsOnly", "DisableServiceWorkers", "DisableJit"],
      "Only the protections applied to the site should be listed, in order"
    );
    Assert.deepEqual(
      Array.from(
        detailsView.querySelectorAll(".lockdown-mode-protection-description"),
        node => node.dataset.l10nId
      ),
      [
        "lockdown-mode-protection-https-only",
        "lockdown-mode-protection-disable-service-workers",
        "lockdown-mode-protection-disable-jit",
      ],
      "Each protection should have its description"
    );
    Assert.ok(
      Array.from(
        detailsView.querySelectorAll(".lockdown-mode-protection-description")
      ).every(node => node.textContent),
      "Descriptions should be translated before the view is shown"
    );

    let mainView = document.getElementById("panelUI-lockdown-mode");
    let mainShown = BrowserTestUtils.waitForEvent(mainView, "ViewShown");
    detailsView.querySelector(".subviewbutton-back").click();
    await mainShown;
    Assert.ok(true, "Back button should return to the main view");

    await closePanel(tempPanel);
  });
});

add_task(async function test_details_subview_updates_per_site() {
  await EnterprisePolicyTesting.setupPolicyEngineWithJson({
    policies: {
      SitePolicies: [
        { Match: ["*.example.com"], Policies: { DisableJit: true } },
        { Match: ["*.example.org"], Policies: { HttpsOnly: true } },
      ],
    },
  });

  await BrowserTestUtils.withNewTab(LOCKED_URL, async () => {
    let { tempPanel, detailsView } = await openDetailsSubview();
    Assert.deepEqual(getListedPolicies(detailsView), ["DisableJit"]);
    await closePanel(tempPanel);
  });

  await BrowserTestUtils.withNewTab(UNLOCKED_URL, async () => {
    let { tempPanel, detailsView } = await openDetailsSubview();
    Assert.deepEqual(getListedPolicies(detailsView), ["HttpsOnly"]);
    await closePanel(tempPanel);
  });
});

add_task(async function test_every_site_policy_is_listed() {
  const sitePolicyNames = Object.keys(
    schema.properties.SitePolicies.items.properties.Policies.properties
  );
  Assert.deepEqual(
    SITE_PROTECTIONS.map(({ policy }) => policy).sort(),
    sitePolicyNames.sort(),
    "Every SitePolicies policy in the schema should have a listed protection"
  );
});

add_task(async function test_button_hidden_when_no_protections_applied() {
  await EnterprisePolicyTesting.setupPolicyEngineWithJson({
    policies: {
      SitePolicies: [
        {
          Match: ["*.example.com"],
          Policies: { DisableJit: false, HttpsOnly: false },
        },
        { Match: ["*.example.com"], Policies: { DisableJit: true } },
        {
          Match: ["*.example.org"],
          Policies: { DisableJit: false, DisableServiceWorkers: true },
        },
      ],
    },
  });

  await BrowserTestUtils.withNewTab(LOCKED_URL, async () => {
    Assert.ok(
      getLockdownUrlbarButton().hidden,
      "The button should be hidden when every matching protection is turned off"
    );
  });

  await BrowserTestUtils.withNewTab(UNLOCKED_URL, async () => {
    Assert.ok(
      !getLockdownUrlbarButton().hidden,
      "The button should be shown when at least one protection is applied"
    );
    let { tempPanel, detailsView } = await openDetailsSubview();
    Assert.equal(
      tempPanel.querySelector("#lockdown-mode-details-count").textContent,
      "1",
      "The count should not include protections that are turned off"
    );
    Assert.deepEqual(
      getListedPolicies(detailsView),
      ["DisableServiceWorkers"],
      "Only the protection that is turned on should be listed"
    );
    await closePanel(tempPanel);
  });
});

add_task(async function test_container_listed_only_when_tab_uses_it() {
  await EnterprisePolicyTesting.setupPolicyEngineWithJson({
    policies: {
      SitePolicies: [
        {
          Match: ["*.example.com"],
          Policies: { DisableJit: true, Container: { id: "lockdown-test" } },
        },
      ],
    },
  });
  const userContextId = Services.policies.getContainerForURI(
    Services.io.newURI(LOCKED_URL)
  );
  Assert.notEqual(userContextId, 0, "The policy should create a container");

  let tab = BrowserTestUtils.addTab(gBrowser, LOCKED_URL, { userContextId });
  gBrowser.selectedTab = tab;
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  let { tempPanel, detailsView } = await openDetailsSubview();
  Assert.deepEqual(
    getListedPolicies(detailsView),
    ["Container", "DisableJit"],
    "Container should be listed for a tab in the policy container"
  );
  await closePanel(tempPanel);
  BrowserTestUtils.removeTab(tab);

  // Private windows never switch containers, so the page stays outside it.
  let privateWin = await BrowserTestUtils.openNewBrowserWindow({
    private: true,
  });
  BrowserTestUtils.startLoadingURIString(
    privateWin.gBrowser.selectedBrowser,
    LOCKED_URL
  );
  await BrowserTestUtils.browserLoaded(privateWin.gBrowser.selectedBrowser);
  ({ tempPanel, detailsView } = await openDetailsSubview(privateWin));
  Assert.deepEqual(
    getListedPolicies(detailsView),
    ["DisableJit"],
    "Container should not be listed for a page outside the policy container"
  );
  await closePanel(tempPanel);
  await BrowserTestUtils.closeWindow(privateWin);
});

add_task(async function test_button_hidden_when_container_not_used() {
  await EnterprisePolicyTesting.setupPolicyEngineWithJson({
    policies: {
      SitePolicies: [
        {
          Match: ["*.example.com"],
          Policies: { Container: { id: "lockdown-test" } },
        },
      ],
    },
  });

  let privateWin = await BrowserTestUtils.openNewBrowserWindow({
    private: true,
  });
  BrowserTestUtils.startLoadingURIString(
    privateWin.gBrowser.selectedBrowser,
    LOCKED_URL
  );
  await BrowserTestUtils.browserLoaded(privateWin.gBrowser.selectedBrowser);
  Assert.ok(
    getLockdownUrlbarButton(privateWin).hidden,
    "The button should be hidden when the only protection is an unused container"
  );
  await BrowserTestUtils.closeWindow(privateWin);
});

add_task(async function test_copy_details() {
  await EnterprisePolicyTesting.setupPolicyEngineWithJson({
    policies: {
      SitePolicies: [
        {
          Match: ["*.example.com"],
          Policies: {
            DisableJit: true,
            HttpsOnly: true,
            DisableServiceWorkers: false,
          },
        },
      ],
    },
  });

  const originalDuration = SitePoliciesButton.COPIED_MESSAGE_DURATION_MS;
  // Long enough for the message to be translated and focused before it reverts.
  SitePoliciesButton.COPIED_MESSAGE_DURATION_MS = 2000;
  registerCleanupFunction(() => {
    SitePoliciesButton.COPIED_MESSAGE_DURATION_MS = originalDuration;
  });

  await BrowserTestUtils.withNewTab(LOCKED_URL, async () => {
    let { tempPanel, detailsView } = await openDetailsSubview();
    let copyButton = detailsView.querySelector(
      "#lockdown-mode-copy-details-button"
    );
    let copiedMessage = detailsView.querySelector(
      "#lockdown-mode-details-copied"
    );

    let [jitDescription, httpsDescription, copiedText] =
      await document.l10n.formatValues([
        { id: "lockdown-mode-protection-disable-jit" },
        { id: "lockdown-mode-protection-https-only" },
        { id: "lockdown-mode-details-copied" },
      ]);

    // The copied state is brief, so record it from mutation callbacks.
    let copiedState = null;
    let copiedStatePromise = BrowserTestUtils.waitForMutationCondition(
      copyButton,
      { attributes: true, attributeFilter: ["hidden"] },
      () => {
        if (copyButton.hidden && !copiedState) {
          copiedState = {
            l10nId: copiedMessage.dataset.l10nId,
            panelState: tempPanel.state,
          };
        }
        return !!copiedState;
      }
    );
    let revertedFocus = null;
    let revertedPromise = BrowserTestUtils.waitForMutationCondition(
      copyButton,
      { attributes: true, attributeFilter: ["hidden"] },
      () => {
        if (copiedState && !copyButton.hidden) {
          revertedFocus = document.activeElement;
          return true;
        }
        return false;
      }
    );

    let messageFocusedText = BrowserTestUtils.waitForEvent(
      copiedMessage,
      "focus"
    ).then(() => copiedMessage.textContent);

    copyButton.focus();
    let copied;
    await SimpleTest.promiseClipboardChange(
      value => {
        copied = value;
        return value.startsWith("https://example.com\n");
      },
      () => copyButton.click()
    );
    let [origin, version, timestamp, ...protections] = copied.split("\n");
    Assert.equal(origin, "https://example.com", "Copies the site origin");
    Assert.equal(
      version,
      `${Services.appinfo.name} ${AppConstants.MOZ_APP_VERSION_DISPLAY} (${Services.appinfo.appBuildID})`,
      "Copies the browser version"
    );
    Assert.ok(
      !Number.isNaN(Date.parse(timestamp)),
      "Copies the time of the copy"
    );
    Assert.deepEqual(
      protections,
      [`HttpsOnly: ${httpsDescription}`, `DisableJit: ${jitDescription}`],
      "Copies only the applied protections, not the ones turned off"
    );

    await copiedStatePromise;
    Assert.equal(
      copiedState.l10nId,
      "lockdown-mode-details-copied",
      "The copy button should be replaced by the copied message"
    );
    Assert.equal(
      await messageFocusedText,
      copiedText,
      "Focus should move to the copied message once it is translated"
    );
    Assert.equal(
      copiedState.panelState,
      "open",
      "Copying should keep the panel open"
    );

    await revertedPromise;
    Assert.equal(
      revertedFocus,
      copyButton,
      "Focus should return to the copy button"
    );
    Assert.equal(
      copiedMessage.textContent,
      "",
      "The copied message should be cleared"
    );
    Assert.ok(
      !copiedMessage.hasAttribute("data-l10n-id"),
      "The copied message should no longer be localized"
    );

    await closePanel(tempPanel);
  });
});

add_task(async function test_keyboard_copy_clears_panel_selection() {
  await setupWithSitePolicies();

  await BrowserTestUtils.withNewTab(LOCKED_URL, async () => {
    let { tempPanel, detailsView } = await openDetailsSubview();
    let copyButton = detailsView.querySelector(
      "#lockdown-mode-copy-details-button"
    );
    let panelView = PanelView.forNode(detailsView);

    for (let i = 0; i < 5 && panelView.selectedElement != copyButton; i++) {
      EventUtils.synthesizeKey("KEY_Tab");
    }
    Assert.equal(
      panelView.selectedElement,
      copyButton,
      "Keyboard navigation should select the copy button"
    );

    let copiedState = BrowserTestUtils.waitForMutationCondition(
      copyButton,
      { attributes: true, attributeFilter: ["hidden"] },
      () => copyButton.hidden
    );
    EventUtils.synthesizeKey("KEY_Enter");
    await copiedState;
    Assert.equal(
      panelView.selectedElement,
      null,
      "The hidden copy button should no longer be the panel's selection"
    );

    await closePanel(tempPanel);
  });
});

add_task(async function test_panel_closes_on_navigation() {
  await setupWithSitePolicies();

  await BrowserTestUtils.withNewTab(LOCKED_URL, async browser => {
    let tempPanel = await openMainView();
    let panelHidden = BrowserTestUtils.waitForEvent(tempPanel, "popuphidden");
    BrowserTestUtils.startLoadingURIString(browser, UNLOCKED_URL);
    await panelHidden;
    Assert.ok(true, "The panel should close when the page navigates");
  });
});
