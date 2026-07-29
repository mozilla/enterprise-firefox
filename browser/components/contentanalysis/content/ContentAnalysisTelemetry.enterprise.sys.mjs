/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Enterprise Content Analysis (DLP) Telemetry Implementation
 *
 * This module is only included in MOZ_ENTERPRISE builds and provides
 * security telemetry when content analysis makes a decision about a
 * user action.
 *
 * ENTERPRISE POLICY CONFIGURATION:
 * ================================
 *
 * The telemetry collection can be configured via enterprise policy. In the
 * enterprise policies.json file:
 *
 * {
 *   "policies": {
 *     "ContentAnalysisTelemetry": {
 *       "Enabled": true,
 *       "UrlLogging": "full",
 *       "RecordEvents": "nonAllow"
 *     }
 *   }
 * }
 *
 * Configuration Options:
 * - Enabled (boolean): Enable/disable content analysis telemetry collection
 * - UrlLogging (string): URL logging level with values:
 *   - "full" (default): Collect the complete URL
 *   - "domain": Collect only the hostname portion of the URL
 *   - "none": Do not collect any URL information
 * - RecordEvents (string): Which outcomes to record, with values:
 *   - "nonAllow" (default): Record everything except verdicts that silently
 *     allowed the operation the user asked for. Report-only verdicts are
 *     recorded, since reporting is the only thing they ask for.
 *   - "all": Also record verdicts that allowed the operation
 */

export const ContentAnalysisTelemetryEnterprise = {
  /**
   * Checks if content analysis telemetry is enabled via enterprise policy.
   *
   * @returns {boolean} True if telemetry should be collected
   */
  _isEnabled() {
    return Services.prefs.getBoolPref(
      "browser.contentanalysis.enterprise.telemetry.enabled",
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
      "browser.contentanalysis.enterprise.telemetry.urlLogging",
      "full"
    );

    if (["full", "domain", "none"].includes(urlLogging)) {
      return urlLogging;
    }

    return "full";
  },

  /**
   * Gets the configured outcome-filtering policy from enterprise policy
   * preferences.
   *
   * @returns {string} One of: "all", "nonAllow"
   */
  _getRecordEventsPolicy() {
    const recordEvents = Services.prefs.getCharPref(
      "browser.contentanalysis.enterprise.telemetry.recordEvents",
      "nonAllow"
    );

    if (["all", "nonAllow"].includes(recordEvents)) {
      return recordEvents;
    }

    return "nonAllow";
  },

  /**
   * Processes a URL based on the configured logging policy.
   *
   * @param {string} url - The original URL
   * @returns {string} Processed URL, hostname, or empty string based on policy
   */
  _processUrl(url) {
    if (!url) {
      return "";
    }

    switch (this._getUrlLoggingPolicy()) {
      case "none":
        return "";

      case "domain":
        try {
          return new URL(url).hostname || "";
        } catch (ex) {
          return "";
        }

      case "full":
      default:
        return url;
    }
  },

  /**
   * Determines whether an event for the given action should be recorded,
   * based on the configured RecordEvents policy.
   *
   * @param {string} action - e.g. "block", "warn", "canceled", or "allow"
   * @returns {boolean} True if this action should be recorded
   */
  _shouldRecordAction(action) {
    if (this._getRecordEventsPolicy() === "all") {
      return true;
    }
    return action !== "allow";
  },

  /**
   * Determines which DLP backend produced the verdict.
   *
   * @returns {boolean} true if the in-process WASM engine was used, false
   *   if an external agent was used.
   */
  _isBuiltinEngine() {
    return Services.prefs.getBoolPref(
      "browser.contentanalysis.use_wasm_backend",
      false
    );
  },

  /**
   * Event types that are recorded whenever telemetry is enabled, regardless
   * of the RecordEvents policy. "warn_resolution" and "warn_cancel" follow up
   * on a warn that was already reportable, and "error_fallback" means content
   * analysis itself failed, which is always reportable.
   */
  _ALWAYS_RECORDED_TYPES: ["warn_resolution", "warn_cancel", "error_fallback"],

  /**
   * Records a telemetry event for a content analysis (DLP) decision.
   *
   * @param {object} details
   * @param {string} details.operation - The user action performed.
   * @param {string} details.url - The URL of the content the action was
   *   performed on.
   * @param {string} details.action - What content analysis decided to do,
   *   e.g. "block", "warn", "canceled", or "allow".
   * @param {string} details.type - "verdict", "error_fallback",
   *   "warn_resolution", or "warn_cancel". See _ALWAYS_RECORDED_TYPES.
   * @param {string} details.analysisType - The request's analysisType as an
   *   AnalysisConnector enum name from analysis.proto, e.g. "FILE_ATTACHED".
   * @param {string} details.reason - The request's reason as a
   *   ContentAnalysisRequest::Reason enum name from analysis.proto, e.g.
   *   "CLIPBOARD_PASTE".
   * @param {string} [details.cancelError] - Why the request was canceled, for
   *   "canceled" actions, e.g. "no_agent" or "timeout".
   * @param {boolean} [details.isCached] - Whether the verdict was reused from
   *   an identical earlier request instead of being analyzed again.
   * @param {string} [details.ruleName] - The name of the rule that produced
   *   the verdict, if any.
   */
  recordRuleTriggered({
    operation,
    url,
    action,
    type,
    analysisType,
    reason,
    cancelError,
    isCached,
    ruleName,
  }) {
    if (!this._isEnabled()) {
      return;
    }

    if (
      !this._ALWAYS_RECORDED_TYPES.includes(type) &&
      !this._shouldRecordAction(action)
    ) {
      return;
    }

    try {
      Glean.contentAnalysis.ruleTriggered.record({
        operation,
        url: this._processUrl(url),
        action,
        type,
        is_builtin: this._isBuiltinEngine(),
        analysis_type: analysisType || "",
        reason: reason || "",
        cancel_error: cancelError || "",
        is_cached: !!isCached,
        rule_name: ruleName || "",
      });

      // Allow tests to disable submission to inspect recorded telemetry
      if (
        !Services.prefs.getBoolPref(
          "browser.contentanalysis.enterprise.telemetry.testing.disableSubmit",
          false
        )
      ) {
        GleanPings.enterprise.submit();
      }
    } catch (ex) {
      // Report but otherwise swallow the failure - telemetry errors should not
      // break content analysis.
      console.error(
        `[ContentAnalysisTelemetryEnterprise] Rule-triggered telemetry recording failed:`,
        ex
      );
    }
  },
};
