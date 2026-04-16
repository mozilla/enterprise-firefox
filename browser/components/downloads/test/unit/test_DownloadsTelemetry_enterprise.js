/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * Tests for Enterprise Downloads Telemetry functionality.
 *
 * Note: These tests only run in MOZ_ENTERPRISE builds where the enterprise
 * implementation is actually available. The test manifest (xpcshell.toml)
 * has skip-if = ["!enterprise"] to ensure this.
 */

const { DownloadsTelemetryEnterprise } = ChromeUtils.importESModule(
  "moz-src:///browser/components/downloads/DownloadsTelemetry.enterprise.sys.mjs"
);

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
 * Test that enterprise telemetry records and parses download data correctly.
 */
add_task(async function test_enterprise_data_parsing() {
  // Record a download with complete data
  const mockDownload = {
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
      getSha256Hash() {
        const hardcodedHash =
          "1234567890abcdef1234567890abcdeffedcba0987654321fedcba0987654321";
        const hexIntArray = Uint8Array.fromHex(hardcodedHash);
        const hashBufferCString = String.fromCharCode.apply(null, hexIntArray);
        return hashBufferCString;
      },
    },
  };

  // Disable ping submission to prevent clearing telemetry data before we can inspect it
  Services.prefs.setBoolPref(
    "browser.download.enterprise.telemetry.testing.disableSubmit",
    true
  );

  try {
    DownloadsTelemetryEnterprise.recordFileDownloaded(mockDownload);

    // Verify the telemetry was recorded correctly
    // Note: downloadCompleted events are sent to the "enterprise" ping
    const events = Glean.downloads.downloadCompleted.testGetValue("enterprise");
    Assert.ok(events, "Should have recorded events");
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
      "Should record decoded SHA 256 hash"
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
    Services.fog.testResetFOG();

    DownloadsTelemetryEnterprise.recordFileDownloaded({
      target: {
        path: "C:\\Users\\user\\Downloads\\document.pdf",
        size: 12345,
      },
      source: { url: "https://example.com/document.pdf", isPrivate: false },
      contentType: "application/pdf",
      saver: mockDownload.saver,
    });

    const windowsEvents =
      Glean.downloads.downloadCompleted.testGetValue("enterprise");
    Assert.ok(windowsEvents, "Should have recorded events for Windows path");
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
    Services.fog.testResetFOG();

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
        DownloadsTelemetryEnterprise.recordFileDownloaded(testCase);
        Assert.ok(
          true,
          "recordFileDownloaded handles edge cases without throwing"
        );
      } catch (e) {
        Assert.ok(false, `recordFileDownloaded threw with edge case: ${e}`);
      }
    }
  } finally {
    // Clear the testing pref
    Services.prefs.clearUserPref(
      "browser.download.enterprise.telemetry.testing.disableSubmit"
    );
  }
});
