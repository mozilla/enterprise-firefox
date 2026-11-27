/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

const { OnboardingMessageProvider } = ChromeUtils.importESModule(
  "resource:///modules/asrouter/OnboardingMessageProvider.sys.mjs"
);

function getTOUScreenContent(message) {
  return message.screens.find(screen => screen.id === "TOU_ONBOARDING").content;
}

function assertEnterpriseTOUContent(content) {
  Assert.equal(
    content.title.string_id,
    "preonboarding-enterprise-title",
    "Uses the enterprise title"
  );
  Assert.equal(
    content.subtitle.string_id,
    "preonboarding-enterprise-subtitle",
    "Uses the enterprise subtitle"
  );
  Assert.deepEqual(
    content.tiles.map(tile => tile.id),
    ["terms_of_use", "privacy_notice"],
    "Only the Terms of Use and Privacy Notice tiles are shown"
  );
  Assert.ok(
    !content.tiles.some(tile => tile.type === "multiselect"),
    "Data collection controls are not shown"
  );
  Assert.equal(
    content.tiles.find(tile => tile.id === "privacy_notice").action.data.args,
    "https://www.firefox.com/enterprise/documentation/",
    "Privacy Notice links to the enterprise privacy notice"
  );
}

add_task(function test_enterprise_preonboarding_message() {
  const message = OnboardingMessageProvider.getPreonboardingMessages().find(
    m => m.id === "NEW_USER_TOU_ONBOARDING"
  );
  assertEnterpriseTOUContent(getTOUScreenContent(message));
});

add_task(function test_enterprise_preonboarding_variables_with_defaults() {
  const variables =
    OnboardingMessageProvider.getPreonboardingVariablesWithDefaults({
      enabled: null,
    });
  assertEnterpriseTOUContent(getTOUScreenContent(variables));
});
