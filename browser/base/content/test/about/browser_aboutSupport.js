/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { ExperimentAPI } = ChromeUtils.importESModule(
  "resource://nimbus/ExperimentAPI.sys.mjs"
);
const { NimbusTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/NimbusTestUtils.sys.mjs"
);
const { RemoteSettings } = ChromeUtils.importESModule(
  "resource://services-settings/remote-settings.sys.mjs"
);
ChromeUtils.defineESModuleGetters(this, {
  sinon: "resource://testing-common/Sinon.sys.mjs",
});

add_task(async function () {
  await BrowserTestUtils.withNewTab(
    { gBrowser, url: "about:support" },
    async function (browser) {
      let keyLocationServiceGoogleStatus = await SpecialPowers.spawn(
        browser,
        [],
        async function () {
          let textBox = content.document.getElementById(
            "key-location-service-google-box"
          );
          await ContentTaskUtils.waitForCondition(
            () => content.document.l10n.getAttributes(textBox).id,
            "Google location service API key status loaded"
          );
          return content.document.l10n.getAttributes(textBox).id;
        }
      );
      ok(
        keyLocationServiceGoogleStatus,
        "Google location service API key status shown"
      );

      let keySafebrowsingGoogleStatus = await SpecialPowers.spawn(
        browser,
        [],
        async function () {
          let textBox = content.document.getElementById(
            "key-safebrowsing-google-box"
          );
          await ContentTaskUtils.waitForCondition(
            () => content.document.l10n.getAttributes(textBox).id,
            "Google Safebrowsing API key status loaded"
          );
          return content.document.l10n.getAttributes(textBox).id;
        }
      );
      ok(
        keySafebrowsingGoogleStatus,
        "Google Safebrowsing API key status shown"
      );

      let keyMozillaStatus = await SpecialPowers.spawn(
        browser,
        [],
        async function () {
          let textBox = content.document.getElementById("key-mozilla-box");
          await ContentTaskUtils.waitForCondition(
            () => content.document.l10n.getAttributes(textBox).id,
            "Mozilla API key status loaded"
          );
          return content.document.l10n.getAttributes(textBox).id;
        }
      );
      ok(keyMozillaStatus, "Mozilla API key status shown");
    }
  );
});

add_task(
  { skip_if: () => !AppConstants.MOZ_ENTERPRISE },
  async function test_disk_encryption_row() {
    // XPCOM registrations are process-local.
    const CASES = [
      {
        status: "full",
        method: "filevault",
        text: "Enabled (FileVault)",
      },
      {
        status: "full",
        method: "zfs",
        text: "Enabled (ZFS)",
      },
      {
        status: "enabled",
        method: "dm-crypt",
        text: "Enabled (dm-crypt); inspection incomplete",
      },
      {
        status: "partial",
        method: "bitlocker",
        text: "Partial (BitLocker); some mounted fixed volumes are not encrypted",
      },
      {
        status: "disabled",
        method: "dm-crypt",
        text: "Disabled",
      },
      {
        status: "in-progress",
        method: "bitlocker",
        text: "Encryption or decryption in progress",
      },
      {
        // The wrapper normalizes an empty method to null.
        status: "unknown",
        method: "",
        text: "Unknown",
      },
    ];

    await BrowserTestUtils.withNewTab(
      { gBrowser, url: "about:support" },
      async browser => {
        for (const testCase of CASES) {
          const [l10nArgs, hidden] = await SpecialPowers.spawn(
            browser,
            [testCase],
            async expected => {
              const { MockRegistrar } = ChromeUtils.importESModule(
                "resource://testing-common/MockRegistrar.sys.mjs"
              );
              const { Troubleshoot } = ChromeUtils.importESModule(
                "resource://gre/modules/Troubleshoot.sys.mjs"
              );

              const cid = MockRegistrar.register(
                "@mozilla.org/enterprise/disk-encryption-checker;1",
                {
                  QueryInterface: ChromeUtils.generateQI([
                    Ci.nsIDiskEncryptionChecker,
                  ]),
                  getDiskEncryption(callback) {
                    callback.onComplete(expected.status, expected.method);
                  },
                }
              );

              const doc = content.document;
              const id = `security-software-disk-encryption-${expected.status}`;
              try {
                const snapshot = await Troubleshoot.snapshot();
                content.wrappedJSObject.snapshotFormatters.securitySoftware(
                  Cu.cloneInto(snapshot.securitySoftware, content)
                );

                const cell = doc.getElementById(
                  "security-software-disk-encryption"
                );
                // Wait for Fluent to replace the previous case's text.
                await ContentTaskUtils.waitForCondition(
                  () =>
                    doc.l10n.getAttributes(cell).id === id &&
                    cell.textContent.trim() === expected.text,
                  `${id} rendered as "${expected.text}", got "${cell.textContent.trim()}"`
                );
                return [
                  doc.l10n.getAttributes(cell).args,
                  doc.getElementById("security-software-disk-encryption-row")
                    .hidden,
                ];
              } finally {
                MockRegistrar.unregister(cid);
              }
            }
          );

          Assert.equal(
            l10nArgs.method,
            testCase.method,
            "The method reaches Fluent, empty when there is none"
          );
          Assert.ok(!hidden, "The disk encryption row is shown");
        }
      }
    );
  }
);

add_task(async function test_nimbus_experiments() {
  await ExperimentAPI.ready();
  let doExperimentCleanup = await NimbusTestUtils.enrollWithFeatureConfig({
    featureId: "aboutwelcome",
    value: { enabled: true },
  });

  await BrowserTestUtils.withNewTab(
    { gBrowser, url: "about:support" },
    async function (browser) {
      let experimentName = await SpecialPowers.spawn(
        browser,
        [],
        async function () {
          await ContentTaskUtils.waitForCondition(
            () =>
              content.document.querySelector(
                "#remote-experiments-tbody tr:first-child td"
              )?.innerText
          );
          return content.document.querySelector(
            "#remote-experiments-tbody tr:first-child td"
          ).innerText;
        }
      );
      ok(
        experimentName.match("Nimbus"),
        "Rendered the expected experiment slug"
      );
    }
  );

  await doExperimentCleanup();
});

add_task(async function test_remote_configuration() {
  await ExperimentAPI.ready();
  let doCleanup = await NimbusTestUtils.enrollWithFeatureConfig(
    {
      featureId: NimbusFeatures.aboutwelcome.featureId,
      value: { enabled: true },
    },
    { isRollout: true }
  );

  await BrowserTestUtils.withNewTab(
    { gBrowser, url: "about:support" },
    async function (browser) {
      let [userFacingName, branch] = await SpecialPowers.spawn(
        browser,
        [],
        async function () {
          await ContentTaskUtils.waitForCondition(
            () =>
              content.document.querySelector(
                "#remote-features-tbody tr:first-child td"
              )?.innerText
          );
          let rolloutName = content.document.querySelector(
            "#remote-features-tbody tr:first-child td"
          ).innerText;
          let branchName = content.document.querySelector(
            "#remote-features-tbody tr:first-child td:nth-child(2)"
          ).innerText;

          return [rolloutName, branchName];
        }
      );
      ok(
        userFacingName.match("NimbusTestUtils recipe"),
        `Rendered the expected rollout ${userFacingName}`
      );
      ok(branch.match("control"), "Rendered the expected rollout branch");
    }
  );

  doCleanup();
});

add_task(async function test_sanitize_paths() {
  await BrowserTestUtils.withNewTab(
    { gBrowser, url: "about:support" },
    async function (browser) {
      let snapshot = {
        secretPath: "/home/user",
        "bool.pref.ending.with.path": true,
        nullValue: null,
        emptyString: "",
        object: {
          SOME_DIR: "/home/kit",
        },
        array: [{ myDirectory: "/home/kit" }],
      };
      snapshot = await SpecialPowers.spawn(
        browser,
        [snapshot],
        async function (aSnapshot) {
          content.sanitizeSnapshot(aSnapshot);
          return aSnapshot;
        }
      );
      Assert.strictEqual(snapshot["bool.pref.ending.with.path"], true);
      Assert.strictEqual(snapshot.nullValue, null);
      Assert.equal(snapshot.secretPath, "<non-empty string>");
      Assert.equal(snapshot.object.SOME_DIR, "<non-empty string>");
      Assert.equal(snapshot.array[0].myDirectory, "<non-empty string>");
      Assert.equal(snapshot.emptyString, "");
    }
  );
});

add_task(async function test_remote_settings() {
  const sandbox = sinon.createSandbox();
  sandbox.stub(RemoteSettings, "inspect").resolves({
    isSynchronizationBroken: false,
    lastCheck: 1715698289,
    localTimestamp: '"1715698176626"',
    history: {
      "settings-sync": [
        { status: "SUCCESS", datetime: "2024-05-14T14:49:36.626Z", infos: {} },
      ],
    },
  });

  await BrowserTestUtils.withNewTab(
    { gBrowser, url: "about:support" },
    async browser => {
      const localTimestamp = await SpecialPowers.spawn(
        browser,
        [],
        async () => {
          const sel = "#support-remote-settings-local-timestamp";
          await ContentTaskUtils.waitForCondition(
            () => content.document.querySelector(sel)?.innerText
          );
          return content.document.querySelector(sel).innerText;
        }
      );
      Assert.equal(
        localTimestamp,
        '"1715698176626"',
        "Rendered the local timestamp"
      );
    }
  );

  registerCleanupFunction(() => {
    sandbox.restore();
  });
});
