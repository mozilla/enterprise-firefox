/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { DownloadsTelemetryEnterprise } = ChromeUtils.importESModule(
  "moz-src:///browser/components/downloads/DownloadsTelemetry.enterprise.sys.mjs"
);

const ADDON_INSTALL_ENABLED_PREF =
  "extensions.enterprise.telemetry.addonInstall.enabled";
const BLOCKLIST_ENABLED_PREF =
  "browser.policies.enterprise.telemetry.blocklistDomainBrowsed.enabled";
const BLOCKLIST_URL_PREF =
  "browser.policies.enterprise.telemetry.blocklistDomainBrowsed.urlLogging";
const DOWNLOAD_ENABLED_PREF = "browser.download.enterprise.telemetry.enabled";
const DOWNLOAD_URL_PREF = "browser.download.enterprise.telemetry.urlLogging";
const DOWNLOAD_FILE_PREF = "browser.download.enterprise.telemetry.fileLogging";
const PRINT_ENABLED_PREF = "print.enterprise.telemetry.printPage.enabled";
const PRINT_URL_PREF = "print.enterprise.telemetry.printPage.urlLogging";
const UNSAFE_DOWNLOAD_ENABLED_PREF =
  "browser.safebrowsing.enterprise.telemetry.unsafeDownload.enabled";
const UNSAFE_DOWNLOAD_URL_PREF =
  "browser.safebrowsing.enterprise.telemetry.unsafeDownload.urlLogging";
const UNSAFE_SITE_ENABLED_PREF =
  "browser.safebrowsing.enterprise.telemetry.unsafeSiteVisit.enabled";
const UNSAFE_SITE_URL_PREF =
  "browser.safebrowsing.enterprise.telemetry.unsafeSiteVisit.urlLogging";
const TEST_URL = "https://example.com/path/file.pdf";

async function updatePolicies(policy) {
  const updateApplied = EnterprisePolicyTesting.awaitNextPolicyUpdate();
  EnterprisePolicyTesting.stubRemotePolicies(policy);
  await updateApplied;
}

add_task(async function test_security_logging_applied_updated_removed_live() {
  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    {
      policies: {
        SecurityLogging: {
          AddonInstall: { Enabled: true },
          BlocklistDomainBrowsed: { Enabled: true, UrlLogging: "domain" },
          Download: {
            Enabled: true,
            UrlLogging: "domain",
            FileLogging: "metadata",
          },
          PrintPage: { Enabled: true, UrlLogging: "none" },
          UnsafeDownload: { Enabled: true, UrlLogging: "domain" },
          UnsafeSiteVisit: { Enabled: true, UrlLogging: "full" },
        },
      },
    },
    null
  );

  EnterprisePolicyTesting.checkPolicyPref(
    ADDON_INSTALL_ENABLED_PREF,
    true,
    true
  );
  EnterprisePolicyTesting.checkPolicyPref(BLOCKLIST_ENABLED_PREF, true, true);
  EnterprisePolicyTesting.checkPolicyPref(BLOCKLIST_URL_PREF, "domain", true);
  EnterprisePolicyTesting.checkPolicyPref(DOWNLOAD_ENABLED_PREF, true, true);
  EnterprisePolicyTesting.checkPolicyPref(DOWNLOAD_URL_PREF, "domain", true);
  EnterprisePolicyTesting.checkPolicyPref(DOWNLOAD_FILE_PREF, "metadata", true);
  EnterprisePolicyTesting.checkPolicyPref(PRINT_ENABLED_PREF, true, true);
  EnterprisePolicyTesting.checkPolicyPref(PRINT_URL_PREF, "none", true);
  EnterprisePolicyTesting.checkPolicyPref(
    UNSAFE_DOWNLOAD_ENABLED_PREF,
    true,
    true
  );
  EnterprisePolicyTesting.checkPolicyPref(
    UNSAFE_DOWNLOAD_URL_PREF,
    "domain",
    true
  );
  EnterprisePolicyTesting.checkPolicyPref(UNSAFE_SITE_ENABLED_PREF, true, true);
  EnterprisePolicyTesting.checkPolicyPref(UNSAFE_SITE_URL_PREF, "full", true);
  Assert.ok(DownloadsTelemetryEnterprise._isEnabled());
  Assert.equal(
    DownloadsTelemetryEnterprise._processSourceUrl(TEST_URL),
    "example.com",
    "the download recorder observes the applied URL logging level"
  );
  Assert.deepEqual(
    DownloadsTelemetryEnterprise._processFileInfo(
      "file.pdf",
      "/tmp/file.pdf",
      "pdf",
      "application/pdf"
    ),
    {
      filename: "",
      file_path: "",
      extension: "pdf",
      mime_type: "application/pdf",
    },
    "the download recorder observes the applied file logging level"
  );

  await updatePolicies({
    policies: {
      SecurityLogging: {
        AddonInstall: { Enabled: false },
        Download: {
          Enabled: false,
          UrlLogging: "none",
          FileLogging: "none",
        },
      },
    },
  });

  EnterprisePolicyTesting.checkPolicyPref(
    ADDON_INSTALL_ENABLED_PREF,
    false,
    true
  );
  EnterprisePolicyTesting.checkPolicyPref(DOWNLOAD_ENABLED_PREF, false, true);
  EnterprisePolicyTesting.checkPolicyPref(DOWNLOAD_URL_PREF, "none", true);
  EnterprisePolicyTesting.checkPolicyPref(DOWNLOAD_FILE_PREF, "none", true);
  EnterprisePolicyTesting.checkPolicyPref(
    BLOCKLIST_ENABLED_PREF,
    undefined,
    false
  );
  EnterprisePolicyTesting.checkPolicyPref(BLOCKLIST_URL_PREF, undefined, false);
  EnterprisePolicyTesting.checkPolicyPref(PRINT_ENABLED_PREF, undefined, false);
  EnterprisePolicyTesting.checkPolicyPref(PRINT_URL_PREF, undefined, false);
  EnterprisePolicyTesting.checkPolicyPref(
    UNSAFE_DOWNLOAD_ENABLED_PREF,
    undefined,
    false
  );
  EnterprisePolicyTesting.checkPolicyPref(
    UNSAFE_DOWNLOAD_URL_PREF,
    undefined,
    false
  );
  EnterprisePolicyTesting.checkPolicyPref(
    UNSAFE_SITE_ENABLED_PREF,
    undefined,
    false
  );
  EnterprisePolicyTesting.checkPolicyPref(
    UNSAFE_SITE_URL_PREF,
    undefined,
    false
  );
  Assert.ok(!DownloadsTelemetryEnterprise._isEnabled());
  Assert.equal(
    DownloadsTelemetryEnterprise._processSourceUrl(TEST_URL),
    null,
    "the download recorder observes a live URL logging update"
  );
  Assert.deepEqual(
    DownloadsTelemetryEnterprise._processFileInfo(
      "file.pdf",
      "/tmp/file.pdf",
      "pdf",
      "application/pdf"
    ),
    { filename: "", file_path: "", extension: "", mime_type: "" },
    "the download recorder observes a live file logging update"
  );

  await updatePolicies({ policies: {} });

  EnterprisePolicyTesting.checkPolicyPref(
    ADDON_INSTALL_ENABLED_PREF,
    undefined,
    false
  );
  EnterprisePolicyTesting.checkPolicyPref(
    DOWNLOAD_ENABLED_PREF,
    undefined,
    false
  );
  EnterprisePolicyTesting.checkPolicyPref(DOWNLOAD_URL_PREF, undefined, false);
  EnterprisePolicyTesting.checkPolicyPref(DOWNLOAD_FILE_PREF, undefined, false);
  Assert.ok(
    !DownloadsTelemetryEnterprise._isEnabled(),
    "the download recorder returns to its disabled default after policy removal"
  );
});

add_task(async function test_unmentioned_settings_are_untouched_live() {
  const defaults = Services.prefs.getDefaultBranch("");
  defaults.setBoolPref(PRINT_ENABLED_PREF, true);
  Services.prefs.lockPref(PRINT_ENABLED_PREF);

  try {
    await updatePolicies({
      policies: {
        SecurityLogging: { Download: { Enabled: true } },
      },
    });

    // The settings a configured event leaves out are locked to their defaults;
    // events the policy does not configure are left alone.
    EnterprisePolicyTesting.checkPolicyPref(DOWNLOAD_ENABLED_PREF, true, true);
    EnterprisePolicyTesting.checkPolicyPref(DOWNLOAD_URL_PREF, "full", true);
    EnterprisePolicyTesting.checkPolicyPref(DOWNLOAD_FILE_PREF, "full", true);
    EnterprisePolicyTesting.checkPolicyPref(PRINT_ENABLED_PREF, true, true);

    await updatePolicies({ policies: {} });

    EnterprisePolicyTesting.checkPolicyPref(
      DOWNLOAD_ENABLED_PREF,
      undefined,
      false
    );
    EnterprisePolicyTesting.checkPolicyPref(
      DOWNLOAD_URL_PREF,
      undefined,
      false
    );
    EnterprisePolicyTesting.checkPolicyPref(
      DOWNLOAD_FILE_PREF,
      undefined,
      false
    );
    EnterprisePolicyTesting.checkPolicyPref(PRINT_ENABLED_PREF, true, true);
  } finally {
    Services.prefs.unlockPref(PRINT_ENABLED_PREF);
    defaults.deleteBranch(PRINT_ENABLED_PREF);
  }
});
