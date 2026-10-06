/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

// Who gets to paste a copy that content analysis blocked while the local
// clipboard (keep_blocked_data_for_same_site) keeps it:
//  - web content in the copying page on the same site does (frames of it included),
//    still subject to the paste check
//  - everything else (other tabs, the same tab once it has navigated away, other
//    sites, cross-site frames, chrome and other applications) gets the placeholder.

"use strict";

/* import-globals-from clipboard_copy_helpers.js */
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "clipboard_copy_helpers.js",
  this
);

let mockCA = makeMockContentAnalysis();

add_setup(async function test_setup() {
  mockCA = await mockContentAnalysisService(mockCA);
});

const withCopyEnabled = (prefs, testFn) =>
  withClipboardCopyPrefs(/* keepLocalCopy */ true, prefs, testFn);

// Blocked copy, then paste on the same page: the original data comes back,
// after going through the paste check as the original data.
add_task(async function testSameSitePasteRestoresBlockedCopy() {
  await withCopyEnabled([], async () => {
    let tab = await openCopyTestPage();
    let browser = tab.linkedBrowser;

    await copyBlocked(mockCA, browser);

    let pasted = await pasteIntoTarget(mockCA, browser, /* allowPaste */ true);
    is(pasted, COPIED_PLAIN_TEXT, "same-site paste restores the blocked copy");
    is(mockCA.calls.length, 1, "the paste was analyzed");
    assertPasteRequest(mockCA.calls[0], COPIED_PLAIN_TEXT, COPY_PAGE_URL);
    is(
      getClipboardText(),
      BLOCKED_REPLACEMENT_TEXT,
      "the system clipboard still only has the placeholder"
    );

    BrowserTestUtils.removeTab(tab);
  });
});

// The restored data is still subject to the paste verdict.
add_task(async function testSameSitePasteStillSubjectToPasteCheck() {
  await withCopyEnabled([], async () => {
    let tab = await openCopyTestPage();
    let browser = tab.linkedBrowser;

    await copyBlocked(mockCA, browser);

    let pasted = await pasteIntoTarget(mockCA, browser, /* allowPaste */ false);
    is(pasted, "", "a blocked paste of the restored data pastes nothing");
    is(mockCA.calls.length, 1, "the paste was analyzed");
    assertPasteRequest(mockCA.calls[0], COPIED_PLAIN_TEXT, COPY_PAGE_URL);

    BrowserTestUtils.removeTab(tab);
  });
});

// navigator.clipboard.readText() goes through the async snapshot path.
add_task(async function testSameSiteReadTextRestoresBlockedCopy() {
  await withCopyEnabled([], async () => {
    let tab = await openCopyTestPage();
    let browser = tab.linkedBrowser;

    await copyBlocked(mockCA, browser);

    mockCA.setupForTest(/* shouldAllowRequest */ true);
    // Must run in the page's realm: readText() uses the subject principal, and
    // calling it from this sandbox would make that the system principal.
    let text = await SpecialPowers.spawn(browser, [], () => {
      return content.eval(
        `navigator.clipboard.readText().then(t => t, e => e.name);`
      );
    });
    is(text, COPIED_PLAIN_TEXT, "readText() returns the blocked copy");
    Assert.greaterOrEqual(mockCA.calls.length, 1, "the read was analyzed");
    assertPasteRequest(mockCA.calls[0], COPIED_PLAIN_TEXT, COPY_PAGE_URL);

    BrowserTestUtils.removeTab(tab);
  });
});

// With all formats analyzed, the paste event sees the blocked copy's flavors,
// not the placeholder's lone text/plain.
add_task(async function testPasteEventTypesReflectBlockedCopy() {
  await withCopyEnabled(
    [
      [
        "browser.contentanalysis.interception_point.clipboard_copy.plain_text_only",
        false,
      ],
    ],
    async () => {
      let tab = await openCopyTestPage();
      let browser = tab.linkedBrowser;

      // text/plain and text/html requests.
      await copyBlocked(mockCA, browser, { expectedCalls: 2 });

      await SpecialPowers.spawn(browser, [], () => {
        content.document.getElementById("pasteTarget").addEventListener(
          "paste",
          event => {
            content.wrappedJSObject.pasteInfo = {
              types: Array.from(event.clipboardData.types),
              html: event.clipboardData.getData("text/html"),
            };
          },
          { once: true }
        );
      });

      let pasted = await pasteIntoTarget(
        mockCA,
        browser,
        /* allowPaste */ true
      );
      is(pasted, COPIED_PLAIN_TEXT, "the paste restored the blocked copy");

      let pasteInfo = await SpecialPowers.spawn(browser, [], () => {
        return content.wrappedJSObject.pasteInfo;
      });
      ok(
        pasteInfo.types.includes("text/html"),
        `paste event types include text/html, got ${pasteInfo.types}`
      );
      ok(
        pasteInfo.html.includes("<b>bold</b>"),
        `paste event has the blocked HTML, got "${pasteInfo.html}"`
      );

      BrowserTestUtils.removeTab(tab);
    }
  );
});

// A different site only ever sees the placeholder.
add_task(async function testCrossSitePasteGetsPlaceholder() {
  await withCopyEnabled([], async () => {
    let tab = await openCopyTestPage();
    await copyBlocked(mockCA, tab.linkedBrowser);

    let otherTab = await openCopyTestPage(OTHER_SITE_COPY_PAGE_URL);
    let pasted = await pasteIntoTarget(
      mockCA,
      otherTab.linkedBrowser,
      /* allowPaste */ true
    );
    is(
      pasted,
      BLOCKED_REPLACEMENT_TEXT,
      "cross-site paste gets the placeholder"
    );
    is(mockCA.calls.length, 1, "the paste was analyzed");
    assertPasteRequest(
      mockCA.calls[0],
      BLOCKED_REPLACEMENT_TEXT,
      OTHER_SITE_COPY_PAGE_URL
    );

    BrowserTestUtils.removeTab(otherTab);
    BrowserTestUtils.removeTab(tab);
  });
});

// The same site in a different tab is not the copying tab, so it only gets
// the placeholder (like bypass_for_same_tab_operations, the rule is same
// tab and same site).
add_task(async function testSameSiteOtherTabGetsPlaceholder() {
  await withCopyEnabled([], async () => {
    let tab = await openCopyTestPage();
    await copyBlocked(mockCA, tab.linkedBrowser);

    let otherTab = await openCopyTestPage(COPY_PAGE_URL);
    let pasted = await pasteIntoTarget(
      mockCA,
      otherTab.linkedBrowser,
      /* allowPaste */ true
    );
    is(
      pasted,
      BLOCKED_REPLACEMENT_TEXT,
      "same-site paste in another tab gets the placeholder"
    );
    is(mockCA.calls.length, 1, "the paste was analyzed");
    assertPasteRequest(
      mockCA.calls[0],
      BLOCKED_REPLACEMENT_TEXT,
      COPY_PAGE_URL
    );

    BrowserTestUtils.removeTab(otherTab);
    BrowserTestUtils.removeTab(tab);
  });
});

// Navigating the copying tab away, even within the site, ends its claim on
// the copy: the new page only gets the placeholder.
add_task(async function testSameTabAfterNavigationGetsPlaceholder() {
  await withCopyEnabled([], async () => {
    let tab = await openCopyTestPage();
    let browser = tab.linkedBrowser;
    await copyBlocked(mockCA, browser);

    let navigated = COPY_PAGE_URL + "?navigated";
    BrowserTestUtils.startLoadingURIString(browser, navigated);
    await BrowserTestUtils.browserLoaded(browser, false, navigated);

    let pasted = await pasteIntoTarget(mockCA, browser, /* allowPaste */ true);
    is(
      pasted,
      BLOCKED_REPLACEMENT_TEXT,
      "same-tab paste after navigating gets the placeholder"
    );
    is(mockCA.calls.length, 1, "the paste was analyzed");
    assertPasteRequest(mockCA.calls[0], BLOCKED_REPLACEMENT_TEXT, navigated);

    BrowserTestUtils.removeTab(tab);
  });
});

// The restored data counts as coming from the same tab for
// bypass_for_same_tab_operations.
add_task(async function testBypassForSameTabSkipsPasteCheck() {
  await withCopyEnabled(
    [["browser.contentanalysis.bypass_for_same_tab_operations", true]],
    async () => {
      let tab = await openCopyTestPage();
      let browser = tab.linkedBrowser;

      await copyBlocked(mockCA, browser);

      // A paste check would block, so getting the data back proves it was
      // skipped.
      let pasted = await pasteIntoTarget(
        mockCA,
        browser,
        /* allowPaste */ false
      );
      is(pasted, COPIED_PLAIN_TEXT, "same-tab paste restores the blocked copy");
      is(mockCA.calls.length, 0, "the same-tab paste was not analyzed");

      BrowserTestUtils.removeTab(tab);
    }
  );
});

// With keep_blocked_data_for_same_site on, an allowed copy lands on the system
// clipboard as usual, and the same-tab bypass skips the paste check only on
// the copying page: after a same-site navigation the paste goes through
// content analysis again, even though it gets the same data.
add_task(async function testBypassForAllowedCopyEndsWithNavigation() {
  await withCopyEnabled(
    [["browser.contentanalysis.bypass_for_same_tab_operations", true]],
    async () => {
      let tab = await openCopyTestPage();
      let browser = tab.linkedBrowser;

      await copyFromPage(mockCA, browser, /* verdict */ true);
      await waitForClipboardText(COPIED_PLAIN_TEXT);

      // A paste check would block, so getting the data proves it was skipped.
      let pasted = await pasteIntoTarget(
        mockCA,
        browser,
        /* allowPaste */ false
      );
      is(pasted, COPIED_PLAIN_TEXT, "the copying page pastes the allowed copy");
      is(mockCA.calls.length, 0, "the same-page paste was not analyzed");

      let navigated = COPY_PAGE_URL + "?navigated";
      BrowserTestUtils.startLoadingURIString(browser, navigated);
      await BrowserTestUtils.browserLoaded(browser, false, navigated);

      pasted = await pasteIntoTarget(mockCA, browser, /* allowPaste */ false);
      is(pasted, "", "the navigated page's paste is blocked by the check");
      is(mockCA.calls.length, 1, "the paste was analyzed, not bypassed");
      assertPasteRequest(mockCA.calls[0], COPIED_PLAIN_TEXT, navigated);

      BrowserTestUtils.removeTab(tab);
    }
  );
});

// The same-tab bypass applies the same page rule: after navigating away the
// paste is analyzed again (and, the copy being gone, gets the placeholder).
add_task(async function testBypassForSameTabEndsWithNavigation() {
  await withCopyEnabled(
    [["browser.contentanalysis.bypass_for_same_tab_operations", true]],
    async () => {
      let tab = await openCopyTestPage();
      let browser = tab.linkedBrowser;

      await copyBlocked(mockCA, browser);

      let navigated = COPY_PAGE_URL + "?navigated";
      BrowserTestUtils.startLoadingURIString(browser, navigated);
      await BrowserTestUtils.browserLoaded(browser, false, navigated);

      let pasted = await pasteIntoTarget(
        mockCA,
        browser,
        /* allowPaste */ true
      );
      is(
        pasted,
        BLOCKED_REPLACEMENT_TEXT,
        "the navigated page gets the placeholder"
      );
      is(mockCA.calls.length, 1, "the paste was analyzed, not bypassed");
      assertPasteRequest(mockCA.calls[0], BLOCKED_REPLACEMENT_TEXT, navigated);

      BrowserTestUtils.removeTab(tab);
    }
  );
});

// Frames inside the copying tab follow the site rule: a same-site frame gets
// the data, a cross-site one the placeholder.
add_task(async function testFramesInCopyingTab() {
  await withCopyEnabled([], async () => {
    let tab = await openCopyTestPage();
    let browser = tab.linkedBrowser;

    await copyBlocked(mockCA, browser);

    await SpecialPowers.spawn(
      browser,
      [COPY_PAGE_URL, OTHER_SITE_COPY_PAGE_URL],
      async (sameSiteUrl, crossSiteUrl) => {
        for (let url of [sameSiteUrl, crossSiteUrl]) {
          let frame = content.document.createElement("iframe");
          frame.src = url;
          let loaded = new Promise(resolve =>
            frame.addEventListener("load", resolve, { once: true })
          );
          content.document.body.appendChild(frame);
          await loaded;
        }
      }
    );
    let [sameSiteFrame, crossSiteFrame] = browser.browsingContext.children;

    let pasted = await pasteIntoTarget(mockCA, sameSiteFrame);
    is(
      pasted,
      COPIED_PLAIN_TEXT,
      "a same-site frame in the copying tab gets the blocked copy"
    );
    pasted = await pasteIntoTarget(mockCA, crossSiteFrame);
    is(
      pasted,
      BLOCKED_REPLACEMENT_TEXT,
      "a cross-site frame in the copying tab gets the placeholder"
    );

    BrowserTestUtils.removeTab(tab);
  });
});
