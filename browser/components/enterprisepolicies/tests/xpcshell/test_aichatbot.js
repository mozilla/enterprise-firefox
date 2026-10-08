/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { CHAT_PROVIDERS_DEFAULT } = ChromeUtils.importESModule(
  "moz-src:///browser/components/genai/GenAI.sys.mjs"
);

add_task(async function test_aichatbot_custom_provider_added() {
  await setupPolicyEngineWithJson({
    policies: {
      AIChatbot: {
        Providers: {
          Add: [
            {
              id: "my-private-ai",
              name: "My Private AI",
              url: "https://example.com/chat",
              iconUrl: "https://example.com/icon.png",
              queryParam: "q",
            },
          ],
        },
      },
    },
  });

  equal(
    Services.policies.status,
    Ci.nsIEnterprisePolicies.ACTIVE,
    "Engine is active"
  );

  let providers = Services.prefs
    .getStringPref("browser.ml.chat.providers", "")
    .split(",");

  ok(
    providers.includes("my-private-ai"),
    "Custom provider was successfully added to the list of providers"
  );
  equal(
    providers.length,
    CHAT_PROVIDERS_DEFAULT.split(",").length + 1,
    "Built-in providers are preserved and the custom provider is appended"
  );
});
