/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_task(async function test_usermessaging() {
  await setupPolicyEngineWithJson({
    policies: {
      UserMessaging: {
        MoreFromMozilla: false,
        FirefoxLabs: false,
      },
    },
  });

  await BrowserTestUtils.withNewTab("about:preferences", async browser => {
    // The category buttons get removed when they aren't visible in SRD.
    let moreFromMozillaCategory = browser.contentDocument.getElementById(
      "category-more-from-mozilla"
    );
    ok(
      !moreFromMozillaCategory || moreFromMozillaCategory.hidden,
      "The more category is hidden"
    );
    let firefoxLabsCategory = browser.contentDocument.getElementById(
      "category-experimental"
    );
    ok(
      !firefoxLabsCategory || firefoxLabsCategory.hidden,
      "The labs category is hidden"
    );
  });
});
