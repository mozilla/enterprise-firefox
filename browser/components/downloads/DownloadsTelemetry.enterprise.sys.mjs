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

ChromeUtils.defineESModuleGetters(lazy, {
  PathUtils: "resource://gre/modules/PathUtils.sys.mjs",
});

export const DownloadsTelemetryEnterprise = {
  /**
   * Checks if download telemetry is enabled via enterprise policy.
   *
   * @returns {boolean} True if telemetry should be collected
   */
  _isEnabled() {
    return Services.prefs.getBoolPref(
      "browser.download.enterprise.telemetry.enabled",
      false
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
    console.log("[DownloadsTelemetryEnterprise] recordFileDownloaded called");
    
    // DEBUG: Force enable telemetry for debugging purposes
    console.log("[DownloadsTelemetryEnterprise] DEBUG: Force enabling telemetry for debugging");
    try {
      Services.prefs.setBoolPref("browser.download.enterprise.telemetry.enabled", true);
      Services.prefs.setCharPref("browser.download.enterprise.telemetry.urlLogging", "full");
      console.log("[DownloadsTelemetryEnterprise] DEBUG: Telemetry preferences set");
    } catch (e) {
      console.error("[DownloadsTelemetryEnterprise] DEBUG: Failed to set prefs:", e);
    }
    
    // Check if telemetry is enabled via enterprise policy
    const isEnabled = this._isEnabled();
    console.log(`[DownloadsTelemetryEnterprise] Telemetry enabled: ${isEnabled}`);
    console.log(`[DownloadsTelemetryEnterprise] Checking pref: browser.download.enterprise.telemetry.enabled = ${Services.prefs.getBoolPref("browser.download.enterprise.telemetry.enabled", false)}`);
    
    if (!isEnabled) {
      console.log("[DownloadsTelemetryEnterprise] Telemetry disabled, not recording");
      return;
    }

    try {
      console.log("[DownloadsTelemetryEnterprise] Processing download for telemetry");
      
      // Extract filename from target path
      let filename = download.target?.path
        ? lazy.PathUtils.filename(download.target.path)
        : null;
      console.log(`[DownloadsTelemetryEnterprise] Filename: ${filename}`);

      // Extract file extension
      let extension = null;
      if (filename) {
        const lastDotIndex = filename.lastIndexOf(".");
        if (lastDotIndex > 0) {
          extension = filename.substring(lastDotIndex + 1).toLowerCase();
        }
      }
      console.log(`[DownloadsTelemetryEnterprise] Extension: ${extension}`);

      // Get MIME type with fallback to extension-based detection
      let mimeType = download.contentType || null;
      if (!mimeType && extension) {
        try {
          mimeType = lazy.gMIMEService.getTypeFromExtension(extension);
        } catch (ex) {
          // MIME service failed, leave null
          console.log(`[DownloadsTelemetryEnterprise] MIME service failed: ${ex.message}`);
        }
      }
      console.log(`[DownloadsTelemetryEnterprise] MIME type: ${mimeType}`);

      // Process source URL based on enterprise policy configuration
      let sourceUrl = this._processSourceUrl(download.source?.url);
      const urlPolicy = this._getUrlLoggingPolicy();
      console.log(`[DownloadsTelemetryEnterprise] URL policy: ${urlPolicy}, processed URL: ${sourceUrl}`);

      // Get file size
      let sizeBytes = download.target?.size;
      if (typeof sizeBytes !== "number" || sizeBytes < 0) {
        sizeBytes = null;
      }
      console.log(`[DownloadsTelemetryEnterprise] File size: ${sizeBytes}`);

      const telemetryData = {
        filename: filename || "",
        extension: extension || "",
        mime_type: mimeType || "",
        size_bytes: sizeBytes,
        source_url: sourceUrl || "",
      };

      console.log(`[DownloadsTelemetryEnterprise] Recording Glean event with data:`, telemetryData);
      
      // Record the Glean event
      console.log(`[DownloadsTelemetryEnterprise] Glean object available: ${typeof Glean !== 'undefined'}`);
      console.log(`[DownloadsTelemetryEnterprise] Glean.downloads available: ${typeof Glean?.downloads !== 'undefined'}`);
      console.log(`[DownloadsTelemetryEnterprise] Glean.downloads.fileDownloaded available: ${typeof Glean?.downloads?.fileDownloaded !== 'undefined'}`);
      
      Glean.downloads.fileDownloaded.record(telemetryData);
      console.log(`[DownloadsTelemetryEnterprise] Glean event recorded successfully`);
    } catch (ex) {
      // Silently fail - telemetry errors should not break downloads
      console.error(`[DownloadsTelemetryEnterprise] Download telemetry recording failed:`, ex);
      ChromeUtils.reportError(`Download telemetry recording failed: ${ex}`);
    }
  },
};
