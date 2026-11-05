/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */
"use strict";

const { ConsoleClient } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/enterprise/modules/ConsoleClient.sys.mjs"
);
const { WatermarkPolicy, getWatermarkConfig } = ChromeUtils.importESModule(
  "moz-src:///browser/components/enterprisepolicies/helpers/WatermarkPolicy.sys.mjs"
);

// All but one of these tests exercise WatermarkPolicy.init()/cleanup()
// directly, rather than through setupPolicyEngineWithJson(): that goes
// through a full, file-based policy engine cycle, which periodically
// re-checks the policies.json file for changes, and a late-firing recheck
// (from this or an earlier test) can race with, and overwrite, the
// configuration these tests assert on. test_watermark_config_published is the
// exception, kept as an integration test to make sure Policies.sys.mjs wires
// all the Watermark policy's parameters through to WatermarkPolicy.init().
add_task(async function test_watermark_copy_falls_back_to_user_email() {
  let originalGetLoggedInUserInfo = ConsoleClient.getLoggedInUserInfo;
  ConsoleClient.getLoggedInUserInfo = async () => ({
    email: "user@example.com",
  });

  try {
    await WatermarkPolicy.init({ match: ["https://example.com/*"] });

    Assert.equal(
      getWatermarkConfig()?.copy,
      "user@example.com",
      "Copy falls back to the logged-in user's email when not configured"
    );
  } finally {
    ConsoleClient.getLoggedInUserInfo = originalGetLoggedInUserInfo;
    WatermarkPolicy.cleanup();
  }
});

add_task(async function test_watermark_no_copy_no_email() {
  let originalGetLoggedInUserInfo = ConsoleClient.getLoggedInUserInfo;
  ConsoleClient.getLoggedInUserInfo = async () => {
    throw new Error("not logged in");
  };

  try {
    await WatermarkPolicy.init({ match: ["https://example.com/*"] });

    Assert.equal(
      getWatermarkConfig()?.copy,
      "CONFIDENTIAL",
      "Copy falls back to a generic default when there's no Copy and no email"
    );
  } finally {
    ConsoleClient.getLoggedInUserInfo = originalGetLoggedInUserInfo;
    WatermarkPolicy.cleanup();
  }
});

add_task(
  async function test_watermark_secondary_copy_email_fetched_for_percent_e() {
    let originalGetLoggedInUserInfo = ConsoleClient.getLoggedInUserInfo;
    ConsoleClient.getLoggedInUserInfo = async () => ({
      email: "user@example.com",
    });

    try {
      // Copy is provided, so the email would normally not need to be fetched,
      // except SecondaryCopy references %e.
      await WatermarkPolicy.init({
        match: ["https://example.com/*"],
        copy: "CONFIDENTIAL",
        secondaryCopy: "%t - %e",
      });

      let config = getWatermarkConfig();
      Assert.equal(config?.copy, "CONFIDENTIAL", "Copy is unaffected");
      Assert.equal(
        config?.email,
        "user@example.com",
        "Email is fetched for the %e placeholder even though Copy was set"
      );
    } finally {
      ConsoleClient.getLoggedInUserInfo = originalGetLoggedInUserInfo;
      WatermarkPolicy.cleanup();
    }
  }
);

add_task(async function test_watermark_copy_email_fetched_for_percent_e() {
  let originalGetLoggedInUserInfo = ConsoleClient.getLoggedInUserInfo;
  ConsoleClient.getLoggedInUserInfo = async () => ({
    email: "user@example.com",
  });

  try {
    // Copy itself can also reference %e; WatermarkChild does the actual
    // substitution, so the raw template is what gets stored here.
    await WatermarkPolicy.init({
      match: ["https://example.com/*"],
      copy: "Printed by %e",
    });

    let config = getWatermarkConfig();
    Assert.equal(
      config?.copy,
      "Printed by %e",
      "Copy is stored as the raw, unsubstituted template"
    );
    Assert.equal(
      config?.email,
      "user@example.com",
      "Email is fetched for the %e placeholder in Copy"
    );
  } finally {
    ConsoleClient.getLoggedInUserInfo = originalGetLoggedInUserInfo;
    WatermarkPolicy.cleanup();
  }
});

add_task(async function test_watermark_defaults() {
  try {
    await WatermarkPolicy.init({
      match: ["https://example.com/*"],
      copy: "INTERNAL",
    });

    let config = getWatermarkConfig();
    Assert.ok(config, "Watermark config is available");
    Assert.equal(config.copy, "INTERNAL", "Copy is stored");
    Assert.equal(
      config.color,
      "rgba(200, 0, 0, 0.5)",
      "A default color is used when none is provided"
    );
    Assert.equal(
      config.fontSize,
      28,
      "A default font size is used when none is provided"
    );
    Assert.equal(
      config.angle,
      -45,
      "A default angle is used when none is provided"
    );
    Assert.equal(
      config.secondaryCopy,
      "%t",
      "A default SecondaryCopy template is used when none is provided"
    );
    Assert.equal(
      config.size,
      300,
      "A default tile size is used when none is provided"
    );
  } finally {
    WatermarkPolicy.cleanup();
  }
});

add_task(async function test_watermark_secondary_copy_disabled() {
  try {
    await WatermarkPolicy.init({
      match: ["https://example.com/*"],
      copy: "INTERNAL",
      secondaryCopy: "",
    });

    Assert.equal(
      getWatermarkConfig()?.secondaryCopy,
      "",
      "SecondaryCopy can be explicitly disabled with an empty string"
    );
  } finally {
    WatermarkPolicy.cleanup();
  }
});

add_task(async function test_watermark_font_size_clamped() {
  try {
    await WatermarkPolicy.init({
      match: ["https://example.com/*"],
      copy: "INTERNAL",
      fontSize: 1000,
    });

    Assert.equal(
      getWatermarkConfig()?.fontSize,
      64,
      "FontSize is clamped to a maximum value"
    );
  } finally {
    WatermarkPolicy.cleanup();
  }
});

add_task(async function test_watermark_size_clamped() {
  try {
    await WatermarkPolicy.init({
      match: ["https://example.com/*"],
      copy: "INTERNAL",
      size: 1,
    });
    Assert.equal(
      getWatermarkConfig()?.size,
      100,
      "Size is clamped to a minimum value"
    );

    await WatermarkPolicy.init({
      match: ["https://example.com/*"],
      copy: "INTERNAL",
      size: 5000,
    });
    Assert.equal(
      getWatermarkConfig()?.size,
      2048,
      "Size is clamped to a maximum value"
    );
  } finally {
    WatermarkPolicy.cleanup();
  }
});

add_task(async function test_watermark_angle_normalized() {
  try {
    await WatermarkPolicy.init({
      match: ["https://example.com/*"],
      copy: "INTERNAL",
      angle: 400,
    });

    Assert.equal(
      getWatermarkConfig()?.angle,
      40,
      "Angle is normalized to a value less than 360 degrees"
    );
  } finally {
    WatermarkPolicy.cleanup();
  }
});

add_task(async function test_watermark_color_sanitized() {
  try {
    await WatermarkPolicy.init({
      match: ["https://example.com/*"],
      copy: "INTERNAL",
      color: "not-a-color",
    });
    Assert.equal(
      getWatermarkConfig()?.color,
      "rgba(200, 0, 0, 0.5)",
      "An invalid Color falls back to the default"
    );

    await WatermarkPolicy.init({
      match: ["https://example.com/*"],
      copy: "INTERNAL",
      color: "hsl(0, 100%, 50%)",
    });
    Assert.equal(
      getWatermarkConfig()?.color,
      "hsl(0, 100%, 50%)",
      "A valid Color in any CSS color syntax is accepted"
    );
  } finally {
    WatermarkPolicy.cleanup();
  }
});

// Integration test: makes sure Policies.sys.mjs reads all of the Watermark
// policy's JSON properties and passes them through to WatermarkPolicy.init().
add_task(async function test_watermark_config_published() {
  await setupPolicyEngineWithJson({
    policies: {
      Watermark: {
        Match: [
          "https://example.com/*",
          "https://*.corp.example.com/*",
          "this is not a valid pattern",
        ],
        Copy: "CONFIDENTIAL",
        Color: "rgba(200, 0, 0, 0.2)",
        FontSize: 40,
        Angle: 30,
        SecondaryCopy: "%t - %e",
        Size: 500,
      },
    },
  });

  let config = getWatermarkConfig();
  Assert.ok(config, "Watermark config is available");
  Assert.deepEqual(
    config.match,
    ["https://example.com/*", "https://*.corp.example.com/*"],
    "Invalid match patterns are filtered out"
  );
  Assert.equal(config.copy, "CONFIDENTIAL", "Copy is stored");
  Assert.equal(config.color, "rgba(200, 0, 0, 0.2)", "Color is stored");
  Assert.equal(config.fontSize, 40, "FontSize is stored");
  Assert.equal(config.angle, 30, "Angle is stored");
  Assert.equal(config.secondaryCopy, "%t - %e", "SecondaryCopy is stored");
  Assert.equal(config.size, 500, "Size is stored");

  await setupPolicyEngineWithJson("");
});
