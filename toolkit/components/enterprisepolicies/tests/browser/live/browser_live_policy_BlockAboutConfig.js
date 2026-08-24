/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const ABOUT_CONFIG_PAGE = "about:config";

// Driving BlockAboutConfig through its full lifecycle live
add_task(async function test_block_about_config_live_lifecycle() {
  info("Starting with no policies");
  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    { policies: {} },
    null
  );
  await checkBlockedPage(ABOUT_CONFIG_PAGE, false);

  info("Applying BlockAboutConfig: true");
  await waitForLivePolicyUpdate({ BlockAboutConfig: true });
  await checkBlockedPage(ABOUT_CONFIG_PAGE, true);

  info("Live-updating BlockAboutConfig to false");
  await waitForLivePolicyUpdate({ BlockAboutConfig: false });
  await checkBlockedPage(ABOUT_CONFIG_PAGE, false);

  info("Removing BlockAboutConfig");
  await waitForLivePolicyUpdate({});
  await checkBlockedPage(ABOUT_CONFIG_PAGE, false);
});
