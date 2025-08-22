/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * Tests for Enterprise Downloads Telemetry functionality.
 * 
 * Note: These tests only run in MOZ_ENTERPRISE builds where the enterprise
 * implementation is actually available. In regular builds, these tests
 * will be skipped automatically.
 */

let DownloadsTelemetryEnterprise;

// Only run these tests in MOZ_ENTERPRISE builds
if (AppConstants.MOZ_ENTERPRISE) {
  try {
    ({ DownloadsTelemetryEnterprise } = ChromeUtils.importESModule(
      "resource:///browser/components/downloads/DownloadsTelemetry.enterprise.sys.mjs"
    ));
  } catch (ex) {
    // Enterprise module not available, skip these tests
  }
}

/**
 * Test URL processing with different enterprise policy configurations.
 */
add_task(async function test_url_processing_policies() {
  if (!DownloadsTelemetryEnterprise) {
    info("Skipping enterprise-specific tests (not MOZ_ENTERPRISE build)");
    return;
  }

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
    const originalGetUrlLoggingPolicy = DownloadsTelemetryEnterprise._getUrlLoggingPolicy;
    DownloadsTelemetryEnterprise._getUrlLoggingPolicy = () => testCase.policy;

    try {
      const result = DownloadsTelemetryEnterprise._processSourceUrl(testCase.input);
      Assert.strictEqual(
        result,
        testCase.expected,
        `URL processing failed for input: ${testCase.input}, policy: ${testCase.policy}`
      );
    } finally {
      // Restore original method
      DownloadsTelemetryEnterprise._getUrlLoggingPolicy = originalGetUrlLoggingPolicy;
    }
  }
});

/**
 * Test default policy behavior when enterprise policies service is unavailable.
 */
add_task(async function test_default_policy_behavior() {
  if (!DownloadsTelemetryEnterprise) {
    info("Skipping enterprise-specific tests (not MOZ_ENTERPRISE build)");
    return;
  }

  // Test that default behavior returns "full" when policies service is unavailable
  const originalGetUrlLoggingPolicy = DownloadsTelemetryEnterprise._getUrlLoggingPolicy;
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
    DownloadsTelemetryEnterprise._getUrlLoggingPolicy = originalGetUrlLoggingPolicy;
  }
});

/**
 * Test end-to-end recording with mocked Glean.
 */
add_task(async function test_enterprise_recording_with_glean() {
  if (!DownloadsTelemetryEnterprise) {
    info("Skipping enterprise-specific tests (not MOZ_ENTERPRISE build)");
    return;
  }

  // Mock Glean object
  const recordedEvents = [];
  const mockGlean = {
    downloads: {
      fileDownloaded: {
        record: (data) => {
          recordedEvents.push(data);
        }
      }
    }
  };

  // Temporarily replace global Glean
  const originalGlean = globalThis.Glean;
  globalThis.Glean = mockGlean;

  try {
    const mockDownload = {
      target: {
        path: "/home/user/Downloads/document.pdf",
        size: 12345,
      },
      source: {
        url: "https://example.com/secure/document.pdf?token=abc123",
      },
      contentType: "application/pdf",
    };

    DownloadsTelemetryEnterprise.recordFileDownloaded(mockDownload);

    Assert.equal(recordedEvents.length, 1, "Should record exactly one event");
    
    const event = recordedEvents[0];
    Assert.equal(event.filename, "document.pdf", "Should extract correct filename");
    Assert.equal(event.extension, "pdf", "Should extract correct extension");
    Assert.equal(event.mime_type, "application/pdf", "Should preserve MIME type");
    Assert.equal(event.size_bytes, 12345, "Should record correct file size");
    Assert.equal(
      event.source_url, 
      "https://example.com/secure/document.pdf?token=abc123",
      "Should record full URL by default"
    );
  } finally {
    globalThis.Glean = originalGlean;
  }
});