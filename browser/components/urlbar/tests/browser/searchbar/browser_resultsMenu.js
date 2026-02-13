/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const TEST_SEARCHES = ["Bob Vylan", "Glasgow Weather", "Joy Formidable"];

let searchbar;

async function addSearches() {
  for (let search of TEST_SEARCHES) {
    await UrlbarTestUtils.formHistory.add([
      { value: search, source: SearchService.defaultEngine.name },
    ]);
  }
}

add_setup(async function () {
  searchbar = document.getElementById("searchbar-new");
  await SearchTestUtils.updateRemoteSettingsConfig([{ identifier: "engine" }]);
});

add_task(async function testDismissRecentSearch() {
  await addSearches();
  await SearchbarTestUtils.promiseAutocompleteResultPopup({
    window,
    value: "",
  });

  let row = SearchbarTestUtils.getRowAt(window, 0);
  Assert.equal(row.result.providerName, "UrlbarProviderRecentSearches");
  Assert.equal(
    SearchbarTestUtils.getResultCount(window),
    TEST_SEARCHES.length,
    "All recent searches are visible"
  );
  await SearchbarTestUtils.openResultMenuAndClickItem(window, "dismiss", {
    resultIndex: 0,
  });
  Assert.ok(
    searchbar.view.isOpen,
    "The view should remain open after clicking the command"
  );
  await SearchbarTestUtils.promisePopupClose(window, () => searchbar.blur());

  // Do the same search again. The suggestion should not appear.
  await SearchbarTestUtils.promiseAutocompleteResultPopup({
    window,
    value: "",
  });
  Assert.equal(
    SearchbarTestUtils.getResultCount(window),
    TEST_SEARCHES.length - 1,
    "Suggestion did not appear"
  );
});
