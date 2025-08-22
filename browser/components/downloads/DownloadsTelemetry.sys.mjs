/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Shim module for Downloads Telemetry.
 *
 * This module provides a stable import path for downloads telemetry functionality.
 * The actual implementation is conditionally provided at build time:
 * - In MOZ_ENTERPRISE builds: Full enterprise telemetry implementation
 * - In regular builds: No-op implementation (enterprise code completely absent)
 */

let DownloadsTelemetryImpl;

try {
  // Attempt to import enterprise implementation (only available in MOZ_ENTERPRISE builds)
  const { DownloadsTelemetryEnterprise } = ChromeUtils.importESModule(
    "resource:///browser/components/downloads/DownloadsTelemetry.enterprise.sys.mjs"
  );
  DownloadsTelemetryImpl = DownloadsTelemetryEnterprise;
} catch (ex) {
  // Enterprise implementation not available, use no-op shim
  DownloadsTelemetryImpl = {
    recordFileDownloaded: () => {
      // No-op: Enterprise telemetry not enabled in this build
    },
  };
}

export const DownloadsTelemetry = DownloadsTelemetryImpl;
