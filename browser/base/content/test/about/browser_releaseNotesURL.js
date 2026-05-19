/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_task(async function test_releaseNotesURL_domain() {
  if (!AppConstants.MOZILLA_OFFICIAL) {
    todo(false, "app.releaseNotesURL is not set on unofficial builds");
    return;
  }
  const defaultBranch = Services.prefs.getDefaultBranch("");
  for (const pref of [
    "app.releaseNotesURL",
    "app.releaseNotesURL.aboutDialog",
    "app.releaseNotesURL.prompt",
  ]) {
    const url = defaultBranch.getCharPref(pref, "");
    if (url) {
      ok(
        url.startsWith("https://www.firefox.com/"),
        `${pref} should point to firefox.com, got: ${url}`
      );
    }
  }
});
