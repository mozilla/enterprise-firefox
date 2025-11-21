/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Enterprise Downloads Telemetry Implementation
 *
 * This module is only included in MOZ_ENTERPRISE builds and provides
 * security telemetry for completed downloads.
 *
 * ENTERPRISE POLICY CONFIGURATION:
 * ================================
 *
 * The telemetry collection can be configured via enterprise policy to control
 * the level of URL information collected. In the enterprise policies.json file:
 *
 * {
 *   "policies": {
 *     "DownloadTelemetry": {
 *       "Enabled": true,
 *       "UrlLogging": "full"
 *     }
 *   }
 * }
 *
 * Configuration Options:
 * - Enabled (boolean): Enable/disable download telemetry collection
 * - UrlLogging (string): URL logging level with values:
 *   - "full" (default): Collect complete download URLs including paths and parameters
 *   - "domain": Collect only the hostname portion of URLs
 *   - "none": Do not collect any URL information
 *
 * SECURITY CONSIDERATIONS:
 * =======================
 *
 * - "full" mode provides maximum visibility for security analysis but may
 *   contain sensitive information in URL paths/parameters
 * - "domain" mode balances security monitoring with privacy by limiting
 *   collection to hostnames only
 * - "none" mode disables URL collection entirely for high-privacy environments
 *
 * The default "full" mode is appropriate for most enterprise environments where
 * comprehensive security monitoring is prioritized.
 */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const lazy = {};

XPCOMUtils.defineLazyServiceGetter(
  lazy,
  "gMIMEService",
  "@mozilla.org/mime;1",
  "nsIMIMEService"
);

// PathUtils will be imported lazily when needed

export const DownloadsTelemetryEnterprise = {
  /**
   * Checks if download telemetry is enabled via enterprise policy.
   *
   * @returns {boolean} True if telemetry should be collected
   */
  _isEnabled() {
    return Services.prefs.getBoolPref(
      "browser.download.enterprise.telemetry.enabled",
      true
    );
  },

  /**
   * Gets the configured URL logging level from enterprise policy preferences.
   *
   * @returns {string} One of: "full", "domain", "none"
   */
  _getUrlLoggingPolicy() {
    const urlLogging = Services.prefs.getCharPref(
      "browser.download.enterprise.telemetry.urlLogging",
      "full"
    );

    // Validate policy value
    if (["full", "domain", "none"].includes(urlLogging)) {
      return urlLogging;
    }

    return "full"; // Default to full URL for enterprise environments
  },

  /**
   * Processes the source URL based on the configured logging policy.
   *
   * @param {string} sourceUrl - The original download URL
   * @returns {string|null} Processed URL or null based on policy
   */
  _processSourceUrl(sourceUrl) {
    if (!sourceUrl) {
      return null;
    }

    const policy = this._getUrlLoggingPolicy();

    switch (policy) {
      case "none":
        return null;

      case "domain":
        try {
          const url = new URL(sourceUrl);
          return url.hostname || null;
        } catch (ex) {
          return null;
        }

      case "full":
      default:
        return sourceUrl;
    }
  },

  /**
   * Records a telemetry event for a completed file download.
   *
   * @param {object} download - The Download object containing download information
   */
  recordFileDownloaded(download) {
    // Check if telemetry is enabled via enterprise policy
    const isEnabled = this._isEnabled();
    if (!isEnabled) {
      return;
    }

    try {
      // Extract filename from target path
      let filename = null;
      if (download.target?.path) {
        filename = PathUtils.filename(download.target.path);
      }

      // Extract file extension
      let extension = null;
      if (filename) {
        const lastDotIndex = filename.lastIndexOf(".");
        if (lastDotIndex > 0) {
          extension = filename.substring(lastDotIndex + 1).toLowerCase();
        }
      }

      // Get MIME type with fallback to extension-based detection
      let mimeType = download.contentType || null;
      if (!mimeType && extension) {
        try {
          mimeType = lazy.gMIMEService.getTypeFromExtension(extension);
        } catch (ex) {
          // MIME service failed, leave null
          console.warn(
            `[DownloadsTelemetryEnterprise] MIME service failed: ${ex.message}`
          );
        }
      }

      // Process source URL based on enterprise policy configuration
      let sourceUrl = this._processSourceUrl(download.source?.url);

      // Get file size
      let sizeBytes = download.target?.size;
      if (typeof sizeBytes !== "number" || sizeBytes < 0) {
        sizeBytes = null;
      }

      const telemetryData = {
        filename: filename || "",
        extension: extension || "",
        mime_type: mimeType || "",
        size_bytes: sizeBytes,
        source_url: sourceUrl || "",
      };

      // Record the Glean event
      Glean.downloads.fileDownloaded.record(telemetryData);

      // Submit the enterprise ping
      GleanPings.enterprise.submit();
    } catch (ex) {
      // Silently fail - telemetry errors should not break downloads
      console.error(
        `[DownloadsTelemetryEnterprise] Download telemetry recording failed:`,
        ex
      );
      try {
        ChromeUtils.reportError(`Download telemetry recording failed: ${ex}`);
      } catch (reportEx) {
        // ChromeUtils.reportError may not be available in all contexts
        console.error(
          `[DownloadsTelemetryEnterprise] Could not report error:`,
          reportEx
        );
      }
    }
  },
};
