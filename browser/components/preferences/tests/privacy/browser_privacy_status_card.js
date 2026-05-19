/* Any copyright is dedicated to the Public Domain.
 * https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const FEATURE_PREF = "browser.settings-redesign.enabled";
const CARD_NAME = "security-privacy-card";
const ISSUE_CONTROL_ID = "securityWarningsGroup";

function getCardAndCheckHeader(document, expectedHeaderL10n) {
  let elements = document.getElementsByTagName(CARD_NAME);
  Assert.equal(elements.length, 1, "Card present in preferences");
  let card = elements[0];
  let header = card.shadowRoot.getElementById("heading");
  Assert.equal(
    header.attributes.getNamedItem("data-l10n-id").value,
    expectedHeaderL10n
  );
  return card;
}

function assertHappyBullets(card) {
  let bullets = card.shadowRoot.querySelectorAll("li");
  Assert.equal(bullets.length, 2);
  for (const bullet of bullets) {
    Assert.equal(
      bullet.classList.contains("status-ok"),
      true,
      "All bullets must be happy!"
    );
  }
}

add_task(async function test_section_hidden_when_feature_flag_disabled() {
  await SpecialPowers.pushPrefEnv({
    set: [[FEATURE_PREF, false]].concat(RESET_PROBLEMATIC_TEST_STATUSES),
  });

  await BrowserTestUtils.withNewTab(
    { gBrowser, url: "about:preferences#privacy" },
    async function (browser) {
      let elements = browser.contentDocument.getElementsByTagName(CARD_NAME);
      Assert.equal(elements.length, 0, "No card present in preferences");
    }
  );

  await SpecialPowers.popPrefEnv();
});

add_task(async function test_section_default_strict_and_issue_states() {
  await SpecialPowers.pushPrefEnv({
    set: [[FEATURE_PREF, true]].concat(RESET_PROBLEMATIC_TEST_STATUSES),
  });

  await BrowserTestUtils.withNewTab(
    { gBrowser, url: "about:preferences#privacy" },
    async function (browser) {
      // 1. Default state: no strict, no issues.
      let card = getCardAndCheckHeader(
        browser.contentDocument,
        "security-privacy-status-ok-header"
      );
      assertHappyBullets(card);
      Assert.equal(
        card.shadowRoot.getElementById("strictEnabled"),
        null,
        "Strict mustn't be enabled"
      );

      // 2. Strict indicator present once the ETP category is "strict".
      await SpecialPowers.pushPrefEnv({
        set: [["browser.contentblocking.category", "strict"]],
      });
      let reloaded = BrowserTestUtils.browserLoaded(browser);
      browser.reload();
      await reloaded;

      card = getCardAndCheckHeader(
        browser.contentDocument,
        "security-privacy-status-ok-header"
      );
      assertHappyBullets(card);
      Assert.notEqual(
        card.shadowRoot.getElementById("strictEnabled"),
        null,
        "Strict must be indicated"
      );

      // 3. Issue present once the testing pref is set.
      await SpecialPowers.pushPrefEnv({
        set: [["privacy.ui.status_card.testing.show_issue", true]],
      });
      reloaded = BrowserTestUtils.browserLoaded(browser);
      browser.reload();
      await reloaded;

      card = getCardAndCheckHeader(
        browser.contentDocument,
        "security-privacy-status-problem-header"
      );
      let bulletIcons = card.shadowRoot.querySelectorAll("li");
      Assert.equal(bulletIcons.length, 2);
      let problemsBulletIcon = bulletIcons[0];
      Assert.ok(problemsBulletIcon.classList.contains("status-alert"));
      Assert.notEqual(
        problemsBulletIcon.querySelector("a"),
        null,
        "Link to issues is present"
      );

      let configCard = browser.contentDocument.getElementById(ISSUE_CONTROL_ID);
      Assert.notEqual(configCard, null, "Issue card is present");
      Assert.equal(configCard.listItems.length, 1, "One issue present");

      await SpecialPowers.popPrefEnv();
      await SpecialPowers.popPrefEnv();
    }
  );

  await SpecialPowers.popPrefEnv();
});

add_task(async function test_issue_fix() {
  await SpecialPowers.pushPrefEnv({
    set: [
      [FEATURE_PREF, true],
      ["privacy.ui.status_card.testing.show_issue", true],
    ].concat(RESET_PROBLEMATIC_TEST_STATUSES),
  });
  Services.fog.testResetFOG();

  await BrowserTestUtils.withNewTab(
    { gBrowser, url: "about:preferences#privacy" },
    async function (browser) {
      // config card
      let configCard = browser.contentDocument.getElementById(ISSUE_CONTROL_ID);
      Assert.notEqual(configCard, null, "Issue card is present");
      let issues = configCard.listItems;
      Assert.equal(issues.length, 1, "One issue present");
      let issue = issues[0];
      let fixButton = issue.querySelector(
        'moz-button[data-l10n-id="issue-card-reset-button"]'
      );
      let prefChange = TestUtils.waitForPrefChange(
        "privacy.ui.status_card.testing.show_issue"
      );
      fixButton.click();
      await prefChange;
      await configCard.updateComplete;
      let afterIssues = configCard.listItems;
      Assert.equal(
        afterIssues.length,
        0,
        "Issues are gone after the pref is fixed"
      );
      Assert.ok(
        !Services.prefs.prefHasUserValue(
          "privacy.ui.status_card.testing.show_issue"
        ),
        "Pref has no user value after clicking the fix button"
      );
      let events =
        Glean.securityPreferencesWarnings.warningFixed.testGetValue();
      Assert.equal(events.length, 1, "One telemetry event was recorded");
      Assert.equal(
        events[0].category,
        "security.preferences.warnings",
        "Category is correct"
      );
      Assert.equal(events[0].name, "warning_fixed", "Event name is correct");

      let warningsShownEvents =
        Glean.securityPreferencesWarnings.warningsShown.testGetValue();
      Assert.equal(
        warningsShownEvents.length,
        1,
        "warningsShown telemetry was recorded exactly once"
      );
      Assert.equal(
        warningsShownEvents[0].extra.count,
        "1",
        "Count of warnings shown is correct"
      );
    }
  );

  await SpecialPowers.popPrefEnv();
});

add_task(async function test_issue_dismiss() {
  await SpecialPowers.pushPrefEnv({
    set: [
      [FEATURE_PREF, true],
      ["privacy.ui.status_card.testing.show_issue", true],
    ].concat(RESET_PROBLEMATIC_TEST_STATUSES),
  });
  Services.fog.testResetFOG();

  await BrowserTestUtils.withNewTab(
    { gBrowser, url: "about:preferences#privacy" },
    async function (browser) {
      // config card
      let configCard = browser.contentDocument.getElementById(ISSUE_CONTROL_ID);
      Assert.notEqual(configCard, null, "Issue card is present");
      let issues = configCard.listItems;
      Assert.equal(issues.length, 1, "One issue present");
      let issue = issues[0];
      let dismissButton = issue.querySelector(
        'moz-button[data-l10n-id="issue-card-dismiss-button"]'
      );
      let prefChange = TestUtils.waitForPrefChange(
        "browser.preferences.config_warning.warningTest.dismissed"
      );
      dismissButton.click();
      await prefChange;
      await configCard.updateComplete;
      let afterIssues = configCard.listItems;
      Assert.equal(
        afterIssues.length,
        0,
        "Issues are gone after the setting is dismissed"
      );
      Assert.ok(
        Services.prefs.prefHasUserValue(
          "browser.preferences.config_warning.warningTest.dismissed"
        ),
        "Pref has no user value after clicking the fix button"
      );
      let events =
        Glean.securityPreferencesWarnings.warningDismissed.testGetValue();
      Assert.equal(events.length, 1, "One telemetry event was recorded");
      Assert.equal(
        events[0].category,
        "security.preferences.warnings",
        "Category is correct"
      );
      Assert.equal(
        events[0].name,
        "warning_dismissed",
        "Event name is correct"
      );
      let warningsShownEvents =
        Glean.securityPreferencesWarnings.warningsShown.testGetValue();
      Assert.equal(
        warningsShownEvents.length,
        1,
        "warningsShown telemetry was recorded exactly once"
      );
      Assert.equal(
        warningsShownEvents[0].extra.count,
        "1",
        "Count of warnings shown is correct"
      );
      Services.prefs.clearUserPref(
        "browser.preferences.config_warning.warningTest.dismissed"
      );
    }
  );

  await SpecialPowers.popPrefEnv();
});

add_task(async function test_dismiss_all_hides_issues() {
  await SpecialPowers.pushPrefEnv({
    set: [
      [FEATURE_PREF, true],
      ["privacy.ui.status_card.testing.show_issue", true],
      ["browser.preferences.config_warning.dismissAll", true],
    ].concat(RESET_PROBLEMATIC_TEST_STATUSES),
  });

  await BrowserTestUtils.withNewTab(
    { gBrowser, url: "about:preferences#privacy" },
    async function (browser) {
      let card = getCardAndCheckHeader(
        browser.contentDocument,
        "security-privacy-status-ok-header"
      );
      assertHappyBullets(card);

      let configCard = browser.contentDocument.getElementById(ISSUE_CONTROL_ID);
      Assert.ok(
        BrowserTestUtils.isHidden(configCard),
        "Issue card is not present when dismissAll is true"
      );
    }
  );

  await SpecialPowers.popPrefEnv();
});

add_task(async function test_update_status_indicator() {
  await SpecialPowers.pushPrefEnv({
    set: [[FEATURE_PREF, true]].concat(RESET_PROBLEMATIC_TEST_STATUSES),
  });

  // Define testers for each UI state.
  let absent = card => {
    let label = card.shadowRoot.querySelector("li:nth-child(3) p");
    Assert.equal(label, null, "No install status label is present");
  };
  let issue = card => {
    let label = card.shadowRoot.querySelector("li:nth-child(3) p");
    Assert.equal(
      label.attributes.getNamedItem("data-l10n-id").value,
      "security-privacy-status-update-error-label",
      "Label correctly identifies an issue"
    );
  };
  let needed = card => {
    let label = card.shadowRoot.querySelector("li:nth-child(3) p");
    Assert.equal(
      label.attributes.getNamedItem("data-l10n-id").value,
      "security-privacy-status-update-needed-label",
      "Label correctly identifies an update is needed"
    );
  };
  let ok = card => {
    let label = card.shadowRoot.querySelector("li:nth-child(3) p");
    Assert.equal(
      label.attributes.getNamedItem("data-l10n-id").value,
      "security-privacy-status-up-to-date-label",
      "Label correctly identifies software up to date"
    );
  };
  let checking = card => {
    let label = card.shadowRoot.querySelector("li:nth-child(3) p");
    Assert.equal(
      label.attributes.getNamedItem("data-l10n-id").value,
      "security-privacy-status-update-checking-label",
      "Label correctly identifies software update checking now"
    );
  };

  // Define the expected result for each different test case.
  // The keys are different AppUpdater.STATUS values.
  let cases = {};
  cases[0] = issue;
  cases[1] = absent;
  cases[2] = absent;
  cases[3] = absent;
  cases[4] = issue;
  cases[5] = needed;
  cases[6] = checking;
  cases[7] = ok;
  cases[8] = needed;
  cases[9] = issue;
  cases[10] = needed;
  cases[11] = needed;
  cases[12] = needed;
  cases[13] = issue;
  cases[14] = issue;

  await BrowserTestUtils.withNewTab(
    { gBrowser, url: "about:preferences#privacy" },
    async function (browser) {
      let elements = browser.contentDocument.getElementsByTagName(CARD_NAME);
      Assert.equal(elements.length, 1, "Card present in preferences");
      let card = elements[0];
      for (const status in cases) {
        info(`testing AppUpdateStatus ${status}`);
        card.appUpdateStatus = parseInt(status);
        await card.updateComplete;
        cases[status](card);
      }
    }
  );

  await SpecialPowers.popPrefEnv();
});
