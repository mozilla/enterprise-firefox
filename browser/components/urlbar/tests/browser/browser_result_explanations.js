/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

// Test for result explanations in the urlbar view ("Last visited {date}",
// "Bookmarked {date}").

"use strict";

const SEARCH_STRING = "explanation-strings";
const URL = "https://example.com/" + SEARCH_STRING;

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.urlbar.resultExplanations.featureGate", true]],
  });

  // Add a visit so we can test its explanation in the view.
  await PlacesTestUtils.addVisits({
    url: URL,
    visitDate: new Date("May 11, 2013 04:00:00 PDT"),
  });

  registerCleanupFunction(async () => {
    await PlacesUtils.history.clear();
  });
});

// The explanation string should be shown on hover.
add_task(async function hover() {
  await UrlbarTestUtils.promiseAutocompleteResultPopup({
    window,
    value: SEARCH_STRING,
  });

  let row = await getHistoryResult();
  await assertExplanationVisibility(row, null);

  // Hover over the history row.
  EventUtils.synthesizeMouseAtCenter(row, { type: "mouseover" }, window);

  await assertExplanationVisibility(row, {
    id: "urlbar-result-explanation-last-visited-absolute-2",
    args: {
      date: "May 11, 2013",
    },
  });

  // Hover over something other than the history row.
  EventUtils.synthesizeMouseAtCenter(gURLBar, { type: "mouseover" }, window);

  await assertExplanationVisibility(row, null);

  await UrlbarTestUtils.promisePopupClose(window);
});

// The explanation string should be shown on keyboard selection.
add_task(async function selection() {
  await UrlbarTestUtils.promiseAutocompleteResultPopup({
    window,
    value: SEARCH_STRING,
  });

  let row = await getHistoryResult();
  await assertExplanationVisibility(row, null);

  // Select the history row.
  EventUtils.synthesizeKey("KEY_ArrowDown");
  Assert.equal(
    UrlbarTestUtils.getSelectedRow(window),
    row,
    "The history row should be selected"
  );

  await assertExplanationVisibility(row, {
    id: "urlbar-result-explanation-last-visited-absolute-2",
    args: {
      date: "May 11, 2013",
    },
  });

  // Press Down one more time to deselect the row.
  EventUtils.synthesizeKey("KEY_ArrowDown");
  Assert.notEqual(
    UrlbarTestUtils.getSelectedRow(window),
    row,
    "The history row should not be selected"
  );

  await assertExplanationVisibility(row, null);

  await UrlbarTestUtils.promisePopupClose(window);
});

// Tests all possible l10n explanation strings, which depend on the visit date
// and current date.
add_task(async function allStrings() {
  let tests = [
    {
      formattedDate: {
        isRelative: false,
        formattedDate: "May 11, 2013",
      },
      expected: {
        id: "urlbar-result-explanation-last-visited-absolute-2",
        args: {
          date: "May 11, 2013",
        },
      },
    },
    {
      formattedDate: {
        isRelative: true,
        formattedDate: "Today",
      },
      expected: {
        id: "urlbar-result-explanation-last-visited-relative-2",
        args: {
          date: "Today",
        },
      },
    },
  ];

  // Each test stubs `UrlbarUtils.formatDate()` using `test.formattedDate`.
  let sandbox = sinon.createSandbox();
  let formatDateStub = sandbox.stub(UrlbarUtils, "formatDate");

  for (let { formattedDate, expected } of tests) {
    formatDateStub.returns(formattedDate);

    await UrlbarTestUtils.promiseAutocompleteResultPopup({
      window,
      value: SEARCH_STRING,
    });

    let row = await getHistoryResult();

    // Select the history row so the explanation appears.
    EventUtils.synthesizeKey("KEY_ArrowDown");
    Assert.equal(
      UrlbarTestUtils.getSelectedRow(window),
      row,
      "The history row should be selected"
    );

    await assertExplanationVisibility(row, expected);

    await UrlbarTestUtils.promisePopupClose(window);
  }

  sandbox.restore();
});

async function getHistoryResult() {
  // Assume the history result is at index 1.
  let details = await UrlbarTestUtils.getDetailsOfResultAt(window, 1);
  Assert.equal(details.url, URL, "The expected result should be found");

  let { row } = details.element;
  return row;
}

function assertExplanationVisibility(row, expectedL10nObject) {
  let explanationElement = row.querySelector(".urlbarView-explanation");
  Assert.ok(explanationElement, "Explanation element should be present");

  let urlElement = row.querySelector(".urlbarView-url");
  Assert.ok(urlElement, "URL element should be present");

  Assert.equal(
    BrowserTestUtils.isVisible(urlElement),
    !expectedL10nObject,
    "The URL visibility should be as expected"
  );
  Assert.equal(
    BrowserTestUtils.isVisible(explanationElement),
    !!expectedL10nObject,
    "The explanation visibility should be as expected"
  );

  if (expectedL10nObject) {
    Assert.deepEqual(
      document.l10n.getAttributes(explanationElement),
      expectedL10nObject,
      "The explanation's l10n object should be as expected"
    );
  }
}
