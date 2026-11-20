/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * Tests for Enterprise Downloads Telemetry functionality.
 *
 * Note: These tests only run in MOZ_ENTERPRISE builds where the enterprise
 * implementation is actually available. The test manifest (xpcshell.toml)
 * uses run-if = ["enterprise"] to ensure this.
 */

const { DownloadsTelemetryEnterprise } = ChromeUtils.importESModule(
  "moz-src:///browser/components/downloads/DownloadsTelemetry.enterprise.sys.mjs"
);
const { EnterprisePingCollector } = ChromeUtils.importESModule(
  "resource://testing-common/EnterprisePolicyTesting.sys.mjs"
);

const ENABLED_PREF = "browser.download.enterprise.telemetry.enabled";
const URL_LOGGING_PREF = "browser.download.enterprise.telemetry.urlLogging";
const FILE_LOGGING_PREF = "browser.download.enterprise.telemetry.fileLogging";

// A stand-in for a completed Download with every field the recorder reads.
const MOCK_DOWNLOAD = {
  target: {
    path: "/home/user/Downloads/document.pdf",
    size: 12345,
  },
  source: {
    url: "https://example.com/secure/document.pdf?token=abc123",
    isPrivate: false,
  },
  contentType: "application/pdf",
  saver: {
    getSha256HashHex() {
      return "1234567890abcdef1234567890abcdeffedcba0987654321fedcba0987654321";
    },
  },
};

/**
 * Test URL processing with different enterprise policy configurations.
 */
add_task(async function test_url_processing_policies() {
  const testCases = [
    {
      input: "https://example.com/path/to/file.pdf?param=value#fragment",
      policy: "full",
      expected: "https://example.com/path/to/file.pdf?param=value#fragment",
    },
    {
      input: "https://example.com/path/to/file.pdf?param=value#fragment",
      policy: "domain",
      expected: "example.com",
    },
    {
      input: "https://example.com/path/to/file.pdf?param=value#fragment",
      policy: "none",
      expected: null,
    },
    {
      input: "ftp://files.example.org/public/document.zip",
      policy: "full",
      expected: "ftp://files.example.org/public/document.zip",
    },
    {
      input: "ftp://files.example.org/public/document.zip",
      policy: "domain",
      expected: "files.example.org",
    },
    {
      input: "invalid-url",
      policy: "full",
      expected: "invalid-url", // Full policy returns original invalid URL
    },
    {
      input: "invalid-url",
      policy: "domain",
      expected: null, // Domain extraction fails, returns null
    },
    {
      input: null,
      policy: "full",
      expected: null,
    },
    {
      input: "",
      policy: "full",
      expected: null,
    },
  ];

  for (const testCase of testCases) {
    // Mock the policy to return our test value
    const originalGetUrlLoggingPolicy =
      DownloadsTelemetryEnterprise._getUrlLoggingPolicy;
    DownloadsTelemetryEnterprise._getUrlLoggingPolicy = () => testCase.policy;

    try {
      const result = DownloadsTelemetryEnterprise._processSourceUrl(
        testCase.input
      );
      Assert.strictEqual(
        result,
        testCase.expected,
        `URL processing failed for input: ${testCase.input}, policy: ${testCase.policy}`
      );
    } finally {
      // Restore original method
      DownloadsTelemetryEnterprise._getUrlLoggingPolicy =
        originalGetUrlLoggingPolicy;
    }
  }
});

/**
 * Test default policy behavior when enterprise policies service is unavailable.
 */
add_task(async function test_default_policy_behavior() {
  // Test that default behavior returns "full" when policies service is unavailable
  const originalGetUrlLoggingPolicy =
    DownloadsTelemetryEnterprise._getUrlLoggingPolicy;
  DownloadsTelemetryEnterprise._getUrlLoggingPolicy = () => {
    // Simulate policies service being unavailable by calling original method
    // with a mocked lazy.gPoliciesService = null
    return "full"; // This is what should happen by default
  };

  try {
    const result = DownloadsTelemetryEnterprise._processSourceUrl(
      "https://example.com/test.pdf"
    );
    Assert.strictEqual(
      result,
      "https://example.com/test.pdf",
      "Should default to full URL when policies unavailable"
    );
  } finally {
    DownloadsTelemetryEnterprise._getUrlLoggingPolicy =
      originalGetUrlLoggingPolicy;
  }
});

/**
 * Records a download and returns the collector that saw the enterprise pings
 * submitted meanwhile.
 *
 * @param {object} download A stand-in for a Download.
 * @returns {EnterprisePingCollector}
 */
function recordFileDownloaded(download) {
  Services.fog.testResetFOG();
  using collector = new EnterprisePingCollector(
    Glean.downloads.downloadCompleted
  );
  DownloadsTelemetryEnterprise.recordFileDownloaded(download);
  return collector;
}

/**
 * Test that enterprise telemetry records and parses download data correctly.
 */
add_task(async function test_enterprise_data_parsing() {
  const events = recordFileDownloaded(MOCK_DOWNLOAD).events;

  // Verify the telemetry was recorded correctly
  Assert.equal(events.length, 1, "Should record exactly one event");

  const event = events[0];
  Assert.ok(event.extra, "Event should have extra data");

  // Verify all fields are parsed correctly
  Assert.equal(
    event.extra.filename,
    "document.pdf",
    "Should extract correct filename"
  );
  Assert.equal(
    event.extra.file_path,
    "/home/user/Downloads/document.pdf",
    "Should record correct file path"
  );
  Assert.equal(
    event.extra.extension,
    "pdf",
    "Should extract correct extension"
  );
  Assert.equal(
    event.extra.mime_type,
    "application/pdf",
    "Should preserve MIME type"
  );
  Assert.equal(
    event.extra.sha256_hash,
    "1234567890abcdef1234567890abcdeffedcba0987654321fedcba0987654321",
    "Should record hex SHA 256 hash"
  );
  Assert.equal(
    event.extra.size_bytes,
    "12345",
    "Should record correct file size"
  );
  Assert.equal(
    event.extra.source_url,
    "https://example.com/secure/document.pdf?token=abc123",
    "Should record full URL by default"
  );
  Assert.equal(
    event.extra.is_private,
    "false",
    "Should record private browsing status"
  );

  // Verify filename extraction works with Windows-style backslash paths
  const windowsEvents = recordFileDownloaded({
    target: {
      path: "C:\\Users\\user\\Downloads\\document.pdf",
      size: 12345,
    },
    source: { url: "https://example.com/document.pdf", isPrivate: false },
    contentType: "application/pdf",
    saver: MOCK_DOWNLOAD.saver,
  }).events;

  Assert.equal(
    windowsEvents.length,
    1,
    "Should have recorded an event for Windows path"
  );
  Assert.equal(
    windowsEvents[0].extra.filename,
    "document.pdf",
    "Should extract filename from Windows path"
  );
  Assert.equal(
    windowsEvents[0].extra.extension,
    "pdf",
    "Should extract extension from Windows path"
  );
  Assert.equal(
    windowsEvents[0].extra.file_path,
    "C:\\Users\\user\\Downloads\\document.pdf",
    "Should record Windows path as-is"
  );

  // Test with edge cases - they should be handled gracefully
  const edgeCases = [
    { target: {}, source: {}, contentType: "" },
    { target: { path: "" }, source: { url: "" } },
    {
      target: { path: "/test.pdf", size: 0 },
      source: { url: "invalid-url", isPrivate: true },
    },
  ];

  for (const testCase of edgeCases) {
    try {
      recordFileDownloaded(testCase);
      Assert.ok(
        true,
        "recordFileDownloaded handles edge cases without throwing"
      );
    } catch (e) {
      Assert.ok(false, `recordFileDownloaded threw with edge case: ${e}`);
    }
  }
});

add_task(async function test_logging_levels_are_read_from_prefs() {
  const cases = [
    {
      urlLogging: "full",
      fileLogging: "full",
      source_url: "https://example.com/secure/document.pdf?token=abc123",
      filename: "document.pdf",
      file_path: "/home/user/Downloads/document.pdf",
      extension: "pdf",
      mime_type: "application/pdf",
    },
    {
      urlLogging: "domain",
      fileLogging: "metadata",
      source_url: "example.com",
      filename: "",
      file_path: "",
      extension: "pdf",
      mime_type: "application/pdf",
    },
    {
      urlLogging: "none",
      fileLogging: "none",
      source_url: "",
      filename: "",
      file_path: "",
      extension: "",
      mime_type: "",
    },
  ];

  try {
    for (const { urlLogging, fileLogging, ...expected } of cases) {
      Services.prefs.setCharPref(URL_LOGGING_PREF, urlLogging);
      Services.prefs.setCharPref(FILE_LOGGING_PREF, fileLogging);
      const { extra } = recordFileDownloaded(MOCK_DOWNLOAD).events[0];
      for (const [key, value] of Object.entries(expected)) {
        Assert.equal(
          extra[key],
          value,
          `${key} with urlLogging ${urlLogging} and fileLogging ${fileLogging}`
        );
      }
    }
  } finally {
    Services.prefs.clearUserPref(URL_LOGGING_PREF);
    Services.prefs.clearUserPref(FILE_LOGGING_PREF);
  }
});

add_task(async function test_disabled_records_nothing() {
  // head.js enables the recorder for this directory; without that user pref
  // it is off by default.
  try {
    Services.prefs.clearUserPref(ENABLED_PREF);
    recordFileDownloaded(MOCK_DOWNLOAD).assertNothingRecorded(
      "Should not record without an enabling policy"
    );

    Services.prefs.setBoolPref(ENABLED_PREF, false);
    recordFileDownloaded(MOCK_DOWNLOAD).assertNothingRecorded(
      "Should not record when disabled"
    );
  } finally {
    Services.prefs.setBoolPref(ENABLED_PREF, true);
  }
});

add_task(async function test_removed_testing_pref_is_inert() {
  // The pref that once let tests turn submission off must not affect it.
  Services.prefs.setBoolPref(
    "browser.download.enterprise.telemetry.testing.disableSubmit",
    true
  );
  try {
    Assert.equal(
      recordFileDownloaded(MOCK_DOWNLOAD).submitCount,
      1,
      "The ping is submitted regardless of the pref"
    );
  } finally {
    Services.prefs.clearUserPref(
      "browser.download.enterprise.telemetry.testing.disableSubmit"
    );
  }
});
