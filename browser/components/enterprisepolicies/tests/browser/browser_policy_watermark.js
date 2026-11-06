/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */
"use strict";

Services.scriptloader.loadSubScript(
  "chrome://mochitests/content/browser/toolkit/components/printing/tests/head.js",
  this
);

const PAGE_URL =
  "http://mochi.test:8888/browser/browser/components/enterprisepolicies/tests/browser/policy_watermark.html";

const MATCHING_POLICY = {
  policies: {
    Watermark: {
      Match: ["*://mochi.test/*policy_watermark*"],
      Copy: "CONFIDENTIAL",
      Color: "rgba(200, 0, 0, 0.2)",
    },
  },
};

const NON_MATCHING_POLICY = {
  policies: {
    Watermark: {
      Match: ["*://nomatch.example.com/*"],
      Copy: "CONFIDENTIAL",
      Color: "rgba(200, 0, 0, 0.2)",
    },
  },
};

// Reader Mode and View Source wrap PAGE_URL in their own scheme. The watermark
// should follow the wrapped URL, not the wrapper: these are watermarked under
// MATCHING_POLICY (whose Match covers PAGE_URL) but not under NON_MATCHING_POLICY.
const READER_URL = "about:reader?url=" + encodeURIComponent(PAGE_URL);
const VIEW_SOURCE_URL = "view-source:" + PAGE_URL;

// Served as application/json, so it renders in the built-in JSON viewer. Its
// URL matches MATCHING_POLICY and its document URI is that same URL, so the
// actor applies directly. The viewer's strict CSP (img-src 'self') would block
// a data: background image, exercising the inline-SVG rendering.
const JSON_URL =
  "http://mochi.test:8888/browser/browser/components/enterprisepolicies/tests/browser/policy_watermark.sjs";

function isShowingWatermark(browser) {
  return SpecialPowers.spawn(browser, [], async () => {
    // Use getExistingActor rather than getActor: the actor is only
    // registered to match the Watermark policy's configured pages, so
    // getActor() would throw on a page that isn't a match instead of
    // simply telling us the watermark isn't showing.
    let actor = content.windowGlobalChild.getExistingActor("WatermarkPolicy");
    return actor?.isShowingWatermark ?? false;
  });
}

function hasReceivedConfig(browser) {
  return SpecialPowers.spawn(browser, [], async () => {
    let actor = content.windowGlobalChild.getExistingActor("WatermarkPolicy");
    return actor?.hasReceivedConfig ?? false;
  });
}

// The print watermark is a real DOM node, so it's subject to the page's
// Content-Security-Policy. It must be drawn as inline SVG (a tiled <pattern>,
// not a data: URL background image, which strict CSPs like the JSON viewer's
// block) and be laid out with a non-zero size. Returns whether both hold.
function isWatermarkRendered(browser) {
  return SpecialPowers.spawn(browser, [], async () => {
    function findWatermark(node) {
      if (node.nodeType === 1 && node.id === "enterprise-watermark") {
        return node;
      }

      for (let child of SpecialPowers.InspectorUtils.getChildrenForNode(node, true, false)) {
        let found = findWatermark(child);
        if (found) {
          return found;
        }
      }
      return null;
    }
    let watermark = findWatermark(content.document);
    info(`watermark: ${watermark}`);
    let svg = watermark?.querySelector("svg");
    if (!svg || !svg.querySelector("pattern")) {
      return false;
    }
    let rect = svg.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
}

function dispatchPrintEvent(browser, eventType) {
  return SpecialPowers.spawn(browser, [eventType], type => {
    content.dispatchEvent(new content.Event(type));
  });
}

add_task(async function test_watermark_shown_on_matching_page() {
  await setupPolicyEngineWithJson(MATCHING_POLICY);

  await BrowserTestUtils.withNewTab(
    { gBrowser, url: PAGE_URL },
    async browser => {
      // The child fetches its configuration from the parent asynchronously, so
      // the watermark may be drawn slightly after the page finishes loading.
      await TestUtils.waitForCondition(
        () => isShowingWatermark(browser),
        "Watermark is drawn on a matching page"
      );
    }
  );

  await setupPolicyEngineWithJson("");
});

add_task(async function test_watermark_not_shown_on_non_matching_page() {
  await setupPolicyEngineWithJson(NON_MATCHING_POLICY);

  await BrowserTestUtils.withNewTab(
    { gBrowser, url: PAGE_URL },
    async browser => {
      ok(
        !(await isShowingWatermark(browser)),
        "Watermark is not drawn on a non-matching page"
      );
    }
  );

  await setupPolicyEngineWithJson("");
});

add_task(async function test_watermark_shown_when_printing() {
  await setupPolicyEngineWithJson(MATCHING_POLICY);

  await BrowserTestUtils.withNewTab(
    { gBrowser, url: PAGE_URL },
    async browser => {
      // Wait for the async configuration fetch to complete (signalled by the
      // on-screen watermark appearing) so the print handler, which runs
      // synchronously, has a configuration to draw from.
      await TestUtils.waitForCondition(
        () => isShowingWatermark(browser),
        "Watermark is drawn before printing"
      );

      let helper = new PrintHelper(browser);
      await helper.startPrint();

      try {
        await TestUtils.waitForCondition(
          () => isWatermarkRendered(helper.currentPrintPreviewBrowser),
          "Watermark is drawn in the print preview"
        );
      } finally {
        await helper.closeDialog();
      }
    }
  );

  await setupPolicyEngineWithJson("");
});

// Reader Mode wraps the original URL as about:reader?url=..., which doesn't
// match the policy's site patterns directly; WatermarkChild unwraps it and
// matches the original URL instead.
add_task(async function test_watermark_shown_on_matching_reader_page() {
  await setupPolicyEngineWithJson(MATCHING_POLICY);

  await BrowserTestUtils.withNewTab(
    { gBrowser, url: READER_URL },
    async browser => {
      await TestUtils.waitForCondition(
        () => isShowingWatermark(browser),
        "Watermark is drawn on a reader page whose original URL matches"
      );
    }
  );

  await setupPolicyEngineWithJson("");
});

add_task(async function test_watermark_not_shown_on_non_matching_reader_page() {
  await setupPolicyEngineWithJson(NON_MATCHING_POLICY);

  await BrowserTestUtils.withNewTab(
    { gBrowser, url: READER_URL },
    async browser => {
      // The actor IS created for reader pages, then decides asynchronously not
      // to draw. Wait until it has its config before asserting it didn't draw.
      await TestUtils.waitForCondition(
        () => hasReceivedConfig(browser),
        "Watermark actor received its configuration"
      );
      ok(
        !(await isShowingWatermark(browser)),
        "Watermark is not drawn on a reader page whose original URL doesn't match"
      );
    }
  );

  await setupPolicyEngineWithJson("");
});

// View Source wraps the original URL as view-source:..., handled the same way.
add_task(async function test_watermark_shown_on_matching_view_source_page() {
  await setupPolicyEngineWithJson(MATCHING_POLICY);

  await BrowserTestUtils.withNewTab(
    { gBrowser, url: VIEW_SOURCE_URL },
    async browser => {
      await TestUtils.waitForCondition(
        () => isShowingWatermark(browser),
        "Watermark is drawn on a view-source page whose original URL matches"
      );
    }
  );

  await setupPolicyEngineWithJson("");
});

add_task(
  async function test_watermark_not_shown_on_non_matching_view_source_page() {
    await setupPolicyEngineWithJson(NON_MATCHING_POLICY);

    await BrowserTestUtils.withNewTab(
      { gBrowser, url: VIEW_SOURCE_URL },
      async browser => {
        await TestUtils.waitForCondition(
          () => hasReceivedConfig(browser),
          "Watermark actor received its configuration"
        );
        ok(
          !(await isShowingWatermark(browser)),
          "Watermark is not drawn on a view-source page whose original URL doesn't match"
        );
      }
    );

    await setupPolicyEngineWithJson("");
  }
);

// Printing a matching reader page exercises the print-watermark path together
// with the reader-URL match gate.
add_task(async function test_watermark_shown_when_printing_reader_page() {
  await setupPolicyEngineWithJson(MATCHING_POLICY);

  await BrowserTestUtils.withNewTab(
    { gBrowser, url: READER_URL },
    async browser => {
      await TestUtils.waitForCondition(
        () => isShowingWatermark(browser),
        "Watermark is drawn before printing the reader page"
      );

      ok(
        await isWatermarkRendered(browser),
        "Watermark renders as inline SVG despite the reader page's CSP"
      );
    }
  );

  await setupPolicyEngineWithJson("");
});

// The JSON viewer renders the resource at its own URL under a strict CSP
// (default-src 'none'; img-src 'self'), which blocks inline styles and data:
// background images. The watermark must still appear, both on screen and when
// printing, via inline SVG styled through the CSSOM.
add_task(async function test_watermark_shown_in_json_viewer() {
  await setupPolicyEngineWithJson(MATCHING_POLICY);

  await BrowserTestUtils.withNewTab(
    { gBrowser, url: JSON_URL },
    async browser => {
      await TestUtils.waitForCondition(
        () => isShowingWatermark(browser),
        "Watermark is drawn in the JSON viewer"
      );

      ok(
        await isWatermarkRendered(browser),
        "Watermark renders as inline SVG despite the JSON viewer's CSP"
      );
    }
  );

  await setupPolicyEngineWithJson("");
});
