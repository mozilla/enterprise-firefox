/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * Tests for Downloads Telemetry functionality.
 */

const { DownloadsTelemetry } = ChromeUtils.importESModule(
  "resource:///browser/components/downloads/DownloadsTelemetry.sys.mjs"
);

/**
 * Test that DownloadsTelemetry.recordFileDownloaded exists and doesn't throw
 * when called with a mock download object.
 */
add_task(async function test_recordFileDownloaded_basic() {
  // Verify the function exists
  Assert.ok(
    typeof DownloadsTelemetry.recordFileDownloaded === "function",
    "recordFileDownloaded function should exist"
  );

  // Mock download object with basic properties
  const mockDownload = {
    target: {
      path: "/path/to/test.pdf",
      size: 12345,
    },
    source: {
      url: "https://example.com/test.pdf",
    },
    contentType: "application/pdf",
  };

  // Should not throw when called
  Assert.doesNotThrow(() => {
    DownloadsTelemetry.recordFileDownloaded(mockDownload);
  }, "recordFileDownloaded should not throw with valid input");
});

/**
 * Test that recordFileDownloaded handles edge cases gracefully.
 */
add_task(async function test_recordFileDownloaded_edge_cases() {
  // Test with null/undefined
  Assert.doesNotThrow(() => {
    DownloadsTelemetry.recordFileDownloaded(null);
  }, "recordFileDownloaded should handle null input");

  Assert.doesNotThrow(() => {
    DownloadsTelemetry.recordFileDownloaded(undefined);
  }, "recordFileDownloaded should handle undefined input");

  // Test with empty object
  Assert.doesNotThrow(() => {
    DownloadsTelemetry.recordFileDownloaded({});
  }, "recordFileDownloaded should handle empty object");

  // Test with minimal download object
  Assert.doesNotThrow(() => {
    DownloadsTelemetry.recordFileDownloaded({
      target: {},
      source: {},
    });
  }, "recordFileDownloaded should handle minimal object");
});

/**
 * Test URL processing with different enterprise policies.
 * Note: This test primarily verifies the shim behavior. In MOZ_ENTERPRISE builds,
 * the actual enterprise implementation would be tested.
 */
add_task(async function test_url_processing_policies() {
  const testUrl = "https://example.com/path/to/file.pdf?param=value";
  
  const mockDownload = {
    target: {
      path: "/tmp/file.pdf",
      size: 1000,
    },
    source: {
      url: testUrl,
    },
    contentType: "application/pdf",
  };

  // The shim implementation should handle all policy configurations gracefully
  Assert.doesNotThrow(() => {
    DownloadsTelemetry.recordFileDownloaded(mockDownload);
  }, "recordFileDownloaded should handle downloads with URLs");

  // Test with invalid URL
  const mockDownloadInvalidUrl = {
    ...mockDownload,
    source: {
      url: "not-a-valid-url",
    },
  };

  Assert.doesNotThrow(() => {
    DownloadsTelemetry.recordFileDownloaded(mockDownloadInvalidUrl);
  }, "recordFileDownloaded should handle invalid URLs");
});