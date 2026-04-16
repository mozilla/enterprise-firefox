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
 * the level of information collected. In the enterprise policies.json file:
 *
 * {
 *   "policies": {
 *     "DownloadTelemetry": {
 *       "Enabled": true,
 *       "UrlLogging": "full",
 *       "FileLogging": "full"
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
 * - FileLogging (string): File information logging level with values:
 *   - "full" (default): Collect filename, extension, and MIME type
 *   - "metadata": Collect only extension and MIME type (no filename)
 *   - "none": Do not collect any file information
 *
 * SECURITY CONSIDERATIONS:
 * =======================
 *
 * - "full" mode provides maximum visibility for security analysis but may
 *   contain sensitive information in URL paths/parameters or filenames
 * - "domain" and "metadata" modes balance security monitoring with privacy
 * - "none" modes disable collection entirely for high-privacy environments
 *
 * The default "full" mode is appropriate for most enterprise environments where
 * comprehensive security monitoring is prioritized.
 */

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
   * Gets the configured file logging level from enterprise policy preferences.
   *
   * @returns {string} One of: "full", "metadata", "none"
   */
  _getFileLoggingPolicy() {
    const fileLogging = Services.prefs.getCharPref(
      "browser.download.enterprise.telemetry.fileLogging",
      "full"
    );

    // Validate policy value
    if (["full", "metadata", "none"].includes(fileLogging)) {
      return fileLogging;
    }

    return "full"; // Default to full file info for enterprise environments
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
   * Processes file information based on the configured logging policy.
   *
   * @param {string} filename - The filename (basename)
   * @param {string} file_path - The full path of the file
   * @param {string} extension - The file extension
   * @param {string} mimeType - The MIME type
   * @returns {object} Object with filename, extension, and mime_type based on policy
   */
  _processFileInfo(filename, file_path, extension, mimeType) {
    const policy = this._getFileLoggingPolicy();

    switch (policy) {
      case "none":
        return {
          filename: "",
          file_path: "",
          extension: "",
          mime_type: "",
        };

      case "metadata":
        // Only log extension and MIME type, no filename
        return {
          filename: "",
          file_path: "",
          extension: extension || "",
          mime_type: mimeType || "",
        };

      case "full":
      default:
        return {
          filename: filename || "",
          file_path: file_path || "",
          extension: extension || "",
          mime_type: mimeType || "",
        };
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
      let file_path = download.target?.path;
      if (file_path) {
        // PathUtils.filename() uses MOZ_RELEASE_ASSERT on Windows for forward
        // slashes, causing a hard process crash not catchable from JS. Use
        // cross-platform splitting to handle both separators safely.
        filename = file_path.split(/[/\\]/).pop() || "";
      }

      // Extract file extension
      let extension = null;
      if (filename) {
        const lastDotIndex = filename.lastIndexOf(".");
        if (lastDotIndex > 0) {
          extension = filename.substring(lastDotIndex + 1).toLowerCase();
        }
      }

      // Use provided content type; avoid MIME service lookup when unavailable.
      let mimeType = download.contentType || "";

      // Process file information based on enterprise policy configuration
      const fileInfo = this._processFileInfo(
        filename,
        file_path,
        extension,
        mimeType
      );

      // Process source URL based on enterprise policy configuration
      let sourceUrl = this._processSourceUrl(download.source?.url);

      // Get file size
      let sizeBytes = download.target?.size;
      if (typeof sizeBytes !== "number" || sizeBytes < 0) {
        sizeBytes = 0;
      }

      const hashBufferCString = download.saver.getSha256Hash();
      const hashHex = hashBufferCString
        ? new Uint8Array(
            Array.from(hashBufferCString, c => c.charCodeAt(0))
          ).toHex()
        : "";

      const telemetryData = {
        filename: fileInfo.filename,
        file_path: fileInfo.file_path,
        extension: fileInfo.extension,
        mime_type: fileInfo.mime_type,
        sha256_hash: hashHex,
        size_bytes: sizeBytes,
        source_url: sourceUrl || "",
        is_private: download.source?.isPrivate || false,
      };

      // Record the Glean event
      Glean.downloads.downloadCompleted.record(telemetryData);

      // Submit the enterprise ping
      // Allow tests to disable submission to inspect recorded telemetry
      if (
        !Services.prefs.getBoolPref(
          "browser.download.enterprise.telemetry.testing.disableSubmit",
          false
        )
      ) {
        GleanPings.enterprise.submit();
      }
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
