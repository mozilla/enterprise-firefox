/* Any copyright is dedicated to the Public Domain.
 * https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const FEATURE_PREF = "browser.settings-redesign.enabled";
const CARD_NAME = "security-privacy-card";

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

// Returns a promise that resolves once `element` intersects the viewport.
// Resolves immediately if it is already in view at call time; otherwise waits
// for IntersectionObserver to report intersection. The synchronous check
// avoids a race where the observer's initial callback (which is dispatched
// async) can fire with isIntersecting:false if the element's state changes
// between observe() and the queued callback, causing the promise to hang.
function waitForInViewport(element, win) {
  let rect = element.getBoundingClientRect();
  if (
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < win.innerHeight &&
    rect.left < win.innerWidth
  ) {
    return Promise.resolve();
  }
  return new Promise(resolve => {
    let observer = new win.IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        observer.disconnect();
        resolve();
      }
    });
    observer.observe(element);
  });
}

add_task(async function test_scroll_issue_link_brings_warning_card_into_view() {
  await SpecialPowers.pushPrefEnv({
    set: [
      [FEATURE_PREF, true],
      ["privacy.ui.status_card.testing.show_issue", true],
      ["general.smoothScroll", false],
    ].concat(RESET_PROBLEMATIC_TEST_STATUSES),
  });

  await BrowserTestUtils.withNewTab(
    { gBrowser, url: "about:preferences#privacy" },
    async function (browser) {
      let doc = browser.contentDocument;
      let win = browser.contentWindow;
      let card = getCardAndCheckHeader(
        doc,
        "security-privacy-status-problem-header"
      );

      let warningCard = doc.getElementById("warningCard");
      Assert.notEqual(warningCard, null, "warningCard exists in the document");
      warningCard.expanded = false;

      let alertBullet = card.shadowRoot.querySelector("li.status-alert");
      let issueLink = alertBullet.querySelector("a");
      Assert.notEqual(issueLink, null, "Issue link is present");
      // The link has href="" which would otherwise navigate the page.
      issueLink.addEventListener("click", e => e.preventDefault(), {
        once: true,
      });

      let inView = waitForInViewport(warningCard, win);
      issueLink.click();
      await inView;

      Assert.ok(
        doc.location.hash.startsWith("#privacy"),
        "Hash remains on #privacy when clicking from #privacy"
      );
      Assert.ok(warningCard.expanded, "Warning card accordion is expanded");
      ok(true, "warningCard intersected the viewport after the click");
    }
  );

  await SpecialPowers.popPrefEnv();
});

add_task(
  async function test_scroll_strict_label_brings_etp_advanced_into_view() {
    await SpecialPowers.pushPrefEnv({
      set: [
        [FEATURE_PREF, true],
        ["browser.contentblocking.category", "strict"],
        ["general.smoothScroll", false],
      ].concat(RESET_PROBLEMATIC_TEST_STATUSES),
    });

    await BrowserTestUtils.withNewTab(
      { gBrowser, url: "about:preferences#privacy" },
      async function (browser) {
        let doc = browser.contentDocument;
        let win = browser.contentWindow;
        let card = getCardAndCheckHeader(
          doc,
          "security-privacy-status-ok-header"
        );

        let strictLabel = card.shadowRoot.getElementById("strictEnabled");
        Assert.notEqual(strictLabel, null, "Strict label is present");
        let strictLink = strictLabel.querySelector("a");
        Assert.notEqual(strictLink, null, "Strict link is present");
        // The link has href="" which would otherwise navigate the page; the
        // click handler is on the <small> ancestor and the link is the
        // a11y-accessible target for clicks.
        strictLink.addEventListener("click", e => e.preventDefault(), {
          once: true,
        });

        let paneShown = BrowserTestUtils.waitForEvent(doc, "paneshown");
        strictLink.click();
        await paneShown;

        Assert.equal(
          doc.location.hash,
          "#etp",
          "Hash is updated to the #etp panel"
        );

        let radioGroup = doc.getElementById(
          "contentBlockingCategoryRadioGroup"
        );
        Assert.notEqual(
          radioGroup,
          null,
          "contentBlockingCategoryRadioGroup exists"
        );
        await waitForInViewport(radioGroup, win);
        ok(
          true,
          "contentBlockingCategoryRadioGroup intersected the viewport after clicking strict label"
        );
      }
    );

    await SpecialPowers.popPrefEnv();
  }
);

add_task(
  async function test_scroll_custom_label_brings_etp_advanced_into_view() {
    await SpecialPowers.pushPrefEnv({
      set: [
        [FEATURE_PREF, true],
        ["browser.contentblocking.category", "custom"],
        ["general.smoothScroll", false],
      ].concat(RESET_PROBLEMATIC_TEST_STATUSES),
    });

    await BrowserTestUtils.withNewTab(
      { gBrowser, url: "about:preferences#privacy" },
      async function (browser) {
        let doc = browser.contentDocument;
        let win = browser.contentWindow;
        let card = getCardAndCheckHeader(
          doc,
          "security-privacy-status-ok-header"
        );

        let customLabel = card.shadowRoot.getElementById("customEnabled");
        Assert.notEqual(customLabel, null, "Custom label is present");
        let customLink = customLabel.querySelector("a");
        Assert.notEqual(customLink, null, "Custom link is present");
        // The link has href="" which would otherwise navigate the page; the
        // click handler is on the <small> ancestor and the link is the
        // a11y-accessible target for clicks.
        customLink.addEventListener("click", e => e.preventDefault(), {
          once: true,
        });

        let paneShown = BrowserTestUtils.waitForEvent(doc, "paneshown");
        customLink.click();
        await paneShown;

        Assert.equal(
          doc.location.hash,
          "#etp",
          "Hash is updated to the #etp panel"
        );

        let radioGroup = doc.getElementById(
          "contentBlockingCategoryRadioGroup"
        );
        Assert.notEqual(
          radioGroup,
          null,
          "contentBlockingCategoryRadioGroup exists"
        );
        await waitForInViewport(radioGroup, win);
        ok(
          true,
          "contentBlockingCategoryRadioGroup intersected the viewport after clicking custom label"
        );
      }
    );

    await SpecialPowers.popPrefEnv();
  }
);

add_task(async function test_scroll_update_button_switches_panel_and_scrolls() {
  if (!AppConstants.MOZ_UPDATER) {
    info("Skipping update button scroll test: MOZ_UPDATER is not enabled");
    return;
  }

  await SpecialPowers.pushPrefEnv({
    set: [
      [FEATURE_PREF, true],
      ["general.smoothScroll", false],
    ].concat(RESET_PROBLEMATIC_TEST_STATUSES),
  });

  await BrowserTestUtils.withNewTab(
    { gBrowser, url: "about:preferences#privacy" },
    async function (browser) {
      let doc = browser.contentDocument;
      let win = browser.contentWindow;
      let card = doc.getElementsByTagName(CARD_NAME)[0];
      Assert.notEqual(card, null, "Card present in preferences");

      // STATUS.MANUAL_UPDATE = 5 -> renders the "update needed" branch whose
      // moz-box-link is bound to scrollToTargetOnPanel("#about", "updateApp").
      card.appUpdateStatus = 5;
      await card.updateComplete;

      let updateLink = card.shadowRoot.querySelector(
        'li.status-alert moz-box-link[data-l10n-id="security-privacy-status-update-button-label"]'
      );
      Assert.notEqual(updateLink, null, "Update box-link is present");

      Assert.equal(
        doc.location.hash,
        "#privacy",
        "Sanity check: starting on #privacy panel"
      );

      let paneShown = BrowserTestUtils.waitForEvent(doc, "paneshown");
      updateLink.click();
      await paneShown;

      Assert.equal(
        doc.location.hash,
        "#about",
        "Hash is updated to the target panel hash"
      );

      let updateApp = doc.querySelector(
        'moz-fieldset[data-subcategory="update-state"]'
      );
      Assert.notEqual(updateApp, null, "updateApp exists in document");
      Assert.ok(updateApp.checkVisibility(), "update element is visible");
      await waitForInViewport(updateApp, win);
      ok(true, "updateApp intersected the viewport after pane switch");
    }
  );

  await SpecialPowers.popPrefEnv();
});
