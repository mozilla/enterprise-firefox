/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

do_get_profile();

const { FELT_OPEN_WINDOW_DISPOSITION, sanitizeFeltURLPayload } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/FeltURLHandler.sys.mjs"
  );

add_task(function test_rejects_disallowed_and_invalid_urls() {
  for (const url of [
    "chrome://browser/content/browser.xhtml",
    "CHROME://browser/content/browser.xhtml",
    "about:config",
    "about:welcome",
    "ABOUT:config",
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "blob:https://example.com/id",
    "view-source:https://example.com/",
    "resource://gre/modules/AppConstants.sys.mjs",
    "moz-extension://00000000-0000-0000-0000-000000000000/page.html",
    "ftp://example.com/file",
    "mailto:someone@example.com",
    "example.com",
    "http://[",
    42,
    false,
    0,
    null,
    {},
    [],
  ]) {
    Assert.equal(sanitizeFeltURLPayload({ url }), null);
  }
  for (const payload of [
    null,
    undefined,
    "https://example.com",
    [],
    [{ url: "https://example.com/" }],
  ]) {
    Assert.equal(sanitizeFeltURLPayload(payload), null);
  }
});

add_task(async function test_external_window_arguments() {
  const { Felt } = ChromeUtils.importESModule(
    "moz-src:///toolkit/components/felt/Felt.sys.mjs"
  );
  const { BrowserWindowTracker } = ChromeUtils.importESModule(
    "resource:///modules/BrowserWindowTracker.sys.mjs"
  );
  const observer = new Felt().urlObserver;
  const originalOpenWindow = BrowserWindowTracker.openWindow;
  let opened;
  BrowserWindowTracker.openWindow = options => {
    opened = options;
  };
  try {
    for (const disposition of [
      FELT_OPEN_WINDOW_DISPOSITION.NEW_WINDOW,
      FELT_OPEN_WINDOW_DISPOSITION.NEW_PRIVATE_WINDOW,
    ]) {
      opened = null;
      const url = "https://example.com/a|https://other.example/b";
      await observer._handleFeltExternalUrl(
        JSON.stringify({ url, disposition })
      );
      Assert.ok(opened, "The external request opens a window");
      Assert.equal(
        opened.args.queryElementAt(0, Ci.nsISupportsString).data,
        url,
        "The full URL remains one window argument"
      );
      Assert.greater(opened.args.length, 2, "Startup bypasses pipe splitting");
      Assert.ok(
        opened.args
          .queryElementAt(1, Ci.nsIPropertyBag2)
          .getPropertyAsBool("fromExternal")
      );
      Assert.ok(
        opened.args.queryElementAt(8, Ci.nsIPrincipal).isSystemPrincipal
      );
      Assert.equal(
        opened.private,
        disposition === FELT_OPEN_WINDOW_DISPOSITION.NEW_PRIVATE_WINDOW
      );
    }
    for (const url of [
      "chrome://browser/content/browser.xhtml",
      "about:config",
      "javascript:alert(1)",
    ]) {
      opened = null;
      await observer._handleFeltExternalUrl(
        JSON.stringify({
          url,
          disposition: FELT_OPEN_WINDOW_DISPOSITION.NEW_WINDOW,
        })
      );
      Assert.equal(opened, null, `${url} never reaches the window opener`);
    }
  } finally {
    BrowserWindowTracker.openWindow = originalOpenWindow;
  }
});

add_task(async function test_external_tab_options() {
  const { Felt } = ChromeUtils.importESModule(
    "moz-src:///toolkit/components/felt/Felt.sys.mjs"
  );
  const { BrowserWindowTracker } = ChromeUtils.importESModule(
    "resource:///modules/BrowserWindowTracker.sys.mjs"
  );
  const originalGetTopWindow = BrowserWindowTracker.getTopWindow;
  let opened;
  let focused = false;
  BrowserWindowTracker.getTopWindow = () => ({
    openTrustedLinkIn(url, where, options) {
      opened = { url, where, options };
    },
    focus() {
      focused = true;
    },
  });
  try {
    const url = "https://example.com/";
    await new Felt().urlObserver._handleFeltExternalUrl(
      JSON.stringify({ url })
    );
    Assert.deepEqual(opened, {
      url,
      where: "tab",
      options: { fromExternal: true },
    });
    Assert.ok(focused, "The receiving browser window is focused");
  } finally {
    BrowserWindowTracker.getTopWindow = originalGetTopWindow;
  }
});

add_task(function test_preserves_allowed_urls() {
  for (const url of [
    "https://example.com/a|https://other.example/b",
    "http://example.com/",
    "HTTPS://EXAMPLE.COM/",
    "file:///tmp/page.html",
    "",
  ]) {
    for (const disposition of Object.values(FELT_OPEN_WINDOW_DISPOSITION)) {
      Assert.deepEqual(sanitizeFeltURLPayload({ url, disposition }), {
        url,
        disposition,
      });
    }
  }
  Assert.deepEqual(sanitizeFeltURLPayload({}), {
    url: "",
    disposition: FELT_OPEN_WINDOW_DISPOSITION.DEFAULT,
  });
});
