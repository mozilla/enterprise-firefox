/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const TAB_URL = URL_ROOT + "resources/session-history/index.html";

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [["devtools.application.sessionHistory.enabled", true]],
  });
});

add_task(async function () {
  await enableApplicationPanel();

  const { panel, tab } = await openNewTabAndApplicationPanel(TAB_URL);
  selectPage(panel, "session-history");

  const doc = panel.panelWin.document;

  const { sessionHistory } = tab.linkedBrowser.browsingContext;
  const { promise: onHistoryCommittedPromise, resolve: onHistoryCommitted } =
    Promise.withResolvers();
  let count = 0;
  const sessionHistoryListener = {
    QueryInterface: ChromeUtils.generateQI([
      "nsISHistoryListener",
      "nsISupportsWeakReference",
    ]),
    OnHistoryCommit: () => {
      if (++count == 2) {
        onHistoryCommitted();
      }
    },
  };

  sessionHistory.addSHistoryListener(sessionHistoryListener);

  info("Navigate the frames.");
  await SpecialPowers.spawn(tab.linkedBrowser, [], async function () {
    for (let index = 0; index < 2; ++index) {
      const frame = content.document.querySelectorAll("iframe")[index];
      const { promise: onLoadFinishedPromise, resolve: onLoadFinished } =
        Promise.withResolvers();
      frame.addEventListener("load", onLoadFinished, { once: true });
      frame.contentWindow.location.href = `${frame.contentWindow.location.href}?${index}`;
      await onLoadFinishedPromise;
    }
  });

  info("Await history commits.");
  await onHistoryCommittedPromise;
  sessionHistory.removeSHistoryListener(sessionHistoryListener);

  // We're navigating to a very specific session history setup, which should in
  // diagram form look like this:
  //
  // +------------------+------------------+------------------+
  // |        0         |        1         |        2         |
  // +------------------+------------------+------------------+
  // | index.html                                             |
  // +------------------+------------------+------------------+
  // | iframe.html      | iframe.html?1                       |
  // +------------------+------------------+------------------+
  // | iframe.html                         | iframe.html?2    |
  // +------------------+------------------+------------------+
  //

  info("Start checking.");
  let table = doc.querySelector("table");
  Assert.equal(4, table.rows.length);
  Assert.equal(1, table.tHead.rows.length);
  Assert.equal(1, table.tBodies.length);
  const tBody = table.tBodies[0];
  Assert.ok(HTMLTableSectionElement.isInstance(tBody));
  let tBodyRows = tBody.rows;
  Assert.equal(3, tBodyRows.length);
  Assert.ok(HTMLTableRowElement.isInstance(tBodyRows[0]));
  Assert.equal(1, tBodyRows[0].cells.length);
  Assert.equal(3, +tBodyRows[0].cells[0].colSpan);
  Assert.ok(HTMLButtonElement.isInstance(tBodyRows[0].cells[0].firstChild));
  Assert.ok(tBodyRows[0].cells[0].firstChild.innerText.endsWith("index.html"));

  Assert.ok(HTMLTableRowElement.isInstance(tBodyRows[1]));
  Assert.equal(2, tBodyRows[1].cells.length);
  Assert.equal(2, tBodyRows[1].cells[1].colSpan);
  Assert.ok(HTMLButtonElement.isInstance(tBodyRows[1].cells[0].firstChild));
  Assert.ok(HTMLButtonElement.isInstance(tBodyRows[1].cells[1].firstChild));
  Assert.ok(tBodyRows[1].cells[0].firstChild.innerText.endsWith("iframe.html"));
  Assert.ok(
    tBodyRows[1].cells[1].firstChild.innerText.endsWith("iframe.html?0")
  );

  Assert.ok(HTMLTableRowElement.isInstance(tBodyRows[2]));
  Assert.equal(2, tBodyRows[2].cells.length);
  Assert.equal(2, tBodyRows[2].cells[0].colSpan);
  Assert.ok(HTMLButtonElement.isInstance(tBodyRows[2].cells[0].firstChild));
  Assert.ok(HTMLButtonElement.isInstance(tBodyRows[2].cells[1].firstChild));
  Assert.ok(tBodyRows[2].cells[0].firstChild.innerText.endsWith("iframe.html"));
  Assert.ok(
    tBodyRows[2].cells[1].firstChild.innerText.endsWith("iframe.html?1")
  );

  info("Click on a button to bring up entry info");
  tBodyRows[2].cells[1].firstChild.click();

  const popover = doc.querySelector(":popover-open");
  Assert.ok(HTMLDivElement.isInstance(popover));
  Assert.ok(HTMLDListElement.isInstance(popover.firstChild));

  const expectedTerms = [
    "url",
    "title",
    "name",
    "id",
    "key",
    "bfcache",
    "parent",
  ];
  const actualTerms = [];
  for (const child of popover.firstChild.getElementsByTagName("dt")) {
    actualTerms.push(child.innerText);
  }

  Assert.deepEqual(expectedTerms, actualTerms);

  const entry = sessionHistory.getEntryAtIndex(2).GetChildAt(1);
  const { URI, title, name, isInBFCache, navigationId, navigationKey, parent } =
    entry;

  const expectedDetails = [
    URI.spec,
    title,
    name,
    navigationId,
    navigationKey,
    isInBFCache,
    parent.navigationId,
  ].map(expected => `${expected}`);
  const actualDetails = [];
  for (const child of popover.firstChild.getElementsByTagName("dd")) {
    actualDetails.push(child.innerText);
  }

  Assert.deepEqual(expectedDetails, actualDetails);

  await BrowserTestUtils.loadURIString({
    browser: tab.linkedBrowser,
    uriString: "about:blank",
  });

  table = doc.querySelector("table");
  tBodyRows = table.tBodies[0].rows;

  Assert.equal(2, tBodyRows[0].cells.length);
  Assert.equal("blank", tBodyRows[0].cells[1].innerText);

  info("Closing the tab.");
  await BrowserTestUtils.removeTab(tab);
});
