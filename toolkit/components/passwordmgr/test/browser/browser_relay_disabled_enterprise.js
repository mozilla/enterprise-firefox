const TEST_URL_PATH = `https://example.org${DIRECTORY_PATH}form_basic_signup.html`;

Services.scriptloader.loadSubScript(
  "chrome://mochitests/content/browser/toolkit/components/passwordmgr/test/browser/browser_relay_utils.js",
  this
);

add_task(async function test_enterprise_relay_feature_default_disabled() {
  Assert.equal(
    Services.prefs
      .getDefaultBranch("")
      .getStringPref("signon.firefoxRelay.feature"),
    "unavailable",
    "signon.firefoxRelay.feature default should be 'unavailable' in enterprise builds"
  );
});

add_task(async function test_enterprise_relay_utils_reports_disabled() {
  const { FirefoxRelayUtils } = ChromeUtils.importESModule(
    "resource://gre/modules/FirefoxRelayUtils.sys.mjs"
  );

  Assert.ok(
    !FirefoxRelayUtils.relayIsAvailableOrEnabled(),
    "FirefoxRelayUtils.relayIsAvailableOrEnabled() should return false when feature is disabled"
  );
});

add_task(
  async function test_enterprise_relay_autocomplete_not_shown_when_disabled() {
    const rsSandbox = await stubRemoteSettingsAllowList();
    await BrowserTestUtils.withNewTab(
      {
        gBrowser,
        url: TEST_URL_PATH,
      },
      async function (browser) {
        const popup = document.getElementById("PopupAutoComplete");
        await openACPopup(popup, browser, "#form-basic-username");

        const relayItem = getRelayItemFromACPopup(popup);
        Assert.ok(
          !relayItem,
          "Relay item SHOULD NOT be present in the autocomplete popup when the feature is disabled"
        );
      }
    );
    rsSandbox.restore();
  }
);
