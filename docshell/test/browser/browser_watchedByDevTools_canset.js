/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

/**
 * Check that watchedByDevTools can only be toggled when DevTools are reported as active
 * in both parent and content process.
 */

const TEST_URI = "https://example.com/document-builder.sjs?html=<div>test";

async function setFromContent(browser) {
  await SpecialPowers.spawn(browser, [], () => {
    content.docShell.browsingContext.watchedByDevTools = true;
  });
}
async function getFromContent(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    return content.docShell.browsingContext.watchedByDevTools;
  });
}

add_task(async function unauthorized() {
  is(
    ChromeUtils.isDevToolsOpened(),
    false,
    "DevTools is considered closed at setup"
  );

  await BrowserTestUtils.withNewTab(TEST_URI, async browser => {
    info("Set the flag from the content process");
    await setFromContent(browser);
    is(
      await getFromContent(browser),
      false,
      "The content process didn't apply it"
    );
    is(
      browser.browsingContext.watchedByDevTools,
      false,
      "The parent process never applied it"
    );
    info("Set the flag from the parent process");
    Assert.throws(() => {
      browser.browsingContext.watchedByDevTools = true;
    }, /watchedByDevTools can only be set when DevTools are opened/);
    is(
      browser.browsingContext.watchedByDevTools,
      false,
      "Setting it from the parent process is also blocked"
    );

    ok(!browser.isCrashed, "The content process was not killed");
  });
});

add_task(async function authorizedFromParent() {
  await BrowserTestUtils.withNewTab(TEST_URI, async browser => {
    info("Set the flag from the parent process");
    ChromeUtils.notifyDevToolsOpened();
    browser.browsingContext.watchedByDevTools = true;

    ChromeUtils.notifyDevToolsClosed();
    is(
      browser.browsingContext.watchedByDevTools,
      true,
      "Setting it from the parent process was accepted"
    );
    is(
      await getFromContent(browser),
      true,
      "The flag is correctly reflected in the content"
    );

    ok(!browser.isCrashed, "The content process was not killed");
  });
});

add_task(async function authorizedFromContent() {
  await BrowserTestUtils.withNewTab(TEST_URI, async browser => {
    info("Set the flag from the content process");
    ChromeUtils.notifyDevToolsOpened();
    await setFromContent(browser);
    ChromeUtils.notifyDevToolsClosed();

    is(
      browser.browsingContext.watchedByDevTools,
      true,
      "Setting it from the content process was accepted"
    );
    is(
      await getFromContent(browser),
      true,
      "The flag is correctly reflected in the content"
    );

    ok(!browser.isCrashed, "The content process was not killed");
  });
});
