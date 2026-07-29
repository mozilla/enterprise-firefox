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
 *       "UrlLogging": "full"
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
 *
 * Verdicts that silently allowed the operation the user asked for aren't
 * recorded.
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
   * Determines whether an event for the given action should be recorded.
   * Verdicts that silently allowed the operation the user asked for aren't
   * recorded, since they aren't relevant to a DLP audit.
   *
   * @param {string} action - e.g. "block", "warn", "canceled", or "allow"
   * @returns {boolean} True if this action should be recorded
   */
  _shouldRecordAction(action) {
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
   * Event types that are recorded whenever telemetry is enabled, even if
   * their action is "allow" (see _shouldRecordAction). "warn_resolution" and
   * "warn_cancel" follow up on a warn that was already reportable, and
   * "error_fallback" means content analysis itself failed, which is always
   * reportable.
   */
  _ALWAYS_RECORDED_TYPES: ["warn_resolution", "warn_cancel", "error_fallback"],

  _OPERATION_TYPE_TELEMETRY_STRINGS: {
    [Ci.nsIContentAnalysisRequest.eClipboard]: "clipboard",
    [Ci.nsIContentAnalysisRequest.eDroppedText]: "dropped_text",
    [Ci.nsIContentAnalysisRequest.eOperationPrint]: "print",
    [Ci.nsIContentAnalysisRequest.eUpload]: "upload",
    [Ci.nsIContentAnalysisRequest.eDownload]: "download",
  },

  _ACTION_TELEMETRY_STRINGS: {
    [Ci.nsIContentAnalysisResponse.eUnspecified]: "unspecified",
    [Ci.nsIContentAnalysisResponse.eReportOnly]: "report_only",
    [Ci.nsIContentAnalysisResponse.eBlock]: "block",
    [Ci.nsIContentAnalysisResponse.eWarn]: "warn",
    [Ci.nsIContentAnalysisResponse.eAllow]: "allow",
    // Content analysis uses eCanceled rather than eBlock when the content
    // should be blocked without showing a block dialog. (an example is
    // the agent being unreachable while
    // browser.contentanalysis.default_result is "block")
    [Ci.nsIContentAnalysisResponse.eCanceled]: "canceled",
  },

  _CANCEL_ERROR_TELEMETRY_STRINGS: {
    [Ci.nsIContentAnalysisResponse.eUserInitiated]: "user_initiated",
    [Ci.nsIContentAnalysisResponse.eNoAgent]: "no_agent",
    [Ci.nsIContentAnalysisResponse.eInvalidAgentSignature]:
      "invalid_agent_signature",
    [Ci.nsIContentAnalysisResponse.eErrorOther]: "error_other",
    [Ci.nsIContentAnalysisResponse.eOtherRequestInGroupCancelled]:
      "other_request_in_group_cancelled",
    [Ci.nsIContentAnalysisResponse.eShutdown]: "shutdown",
    [Ci.nsIContentAnalysisResponse.eTimeout]: "timeout",
  },

  // These match the AnalysisConnector enum names in analysis.proto, so the
  // values line up with the labels of the
  // content_analysis.request_sent_by_analysis_type counter.
  _ANALYSIS_TYPE_TELEMETRY_STRINGS: {
    [Ci.nsIContentAnalysisRequest.eUnspecified]:
      "ANALYSIS_CONNECTOR_UNSPECIFIED",
    [Ci.nsIContentAnalysisRequest.eFileDownloaded]: "FILE_DOWNLOADED",
    [Ci.nsIContentAnalysisRequest.eFileAttached]: "FILE_ATTACHED",
    [Ci.nsIContentAnalysisRequest.eBulkDataEntry]: "BULK_DATA_ENTRY",
    [Ci.nsIContentAnalysisRequest.ePrint]: "PRINT",
    [Ci.nsIContentAnalysisRequest.eFileTransfer]: "FILE_TRANSFER",
    [Ci.nsIContentAnalysisRequest.eDataCopied]: "DATA_COPIED",
  },

  // These match the ContentAnalysisRequest::Reason enum names in
  // analysis.proto, so the values line up with the labels of the
  // content_analysis.request_sent_by_reason counter.
  _REASON_TELEMETRY_STRINGS: {
    [Ci.nsIContentAnalysisRequest.eUnknown]: "UNKNOWN",
    [Ci.nsIContentAnalysisRequest.eClipboardPaste]: "CLIPBOARD_PASTE",
    [Ci.nsIContentAnalysisRequest.eDragAndDrop]: "DRAG_AND_DROP",
    [Ci.nsIContentAnalysisRequest.eFilePickerDialog]: "FILE_PICKER_DIALOG",
    [Ci.nsIContentAnalysisRequest.ePrintPreviewPrint]: "PRINT_PREVIEW_PRINT",
    [Ci.nsIContentAnalysisRequest.eSystemDialogPrint]: "SYSTEM_DIALOG_PRINT",
    [Ci.nsIContentAnalysisRequest.eNormalDownload]: "NORMAL_DOWNLOAD",
    [Ci.nsIContentAnalysisRequest.eSaveAsDownload]: "SAVE_AS_DOWNLOAD",
    [Ci.nsIContentAnalysisRequest.eClipboardCopy]: "CLIPBOARD_COPY",
  },

  /**
   * Telemetry context for warn responses, kept around between the initial
   * "warn" rule_triggered event and the "dlp-warn-resolved" notification
   * that reports how the warn was resolved.
   *
   * @type {Map<string, {operation: string, url: string,
   *   analysisType: string, reason: string, ruleName: string}>}
   */
  _pendingWarnTelemetryInfo: new Map(),

  /**
   * Forgets any in-flight telemetry state. Called when ContentAnalysis is
   * uninitialized (e.g. content analysis becoming inactive, or shutdown).
   */
  reset() {
    this._pendingWarnTelemetryInfo.clear();
  },

  /**
   * Records rule_triggered telemetry for a content analysis response.
   *
   * @param {object} aRequestInfo The cached request info for this response's
   *   requestToken (see ContentAnalysis.requestTokenToRequestInfo).
   * @param {nsIContentAnalysisResponse} aResponse
   */
  recordVerdict(aRequestInfo, aResponse) {
    const action =
      this._ACTION_TELEMETRY_STRINGS[aResponse.action] ??
      "unknown:" + aResponse.action;
    const isCancel =
      aResponse.action === Ci.nsIContentAnalysisResponse.eCanceled;
    const requestDetails = {
      operation:
        this._OPERATION_TYPE_TELEMETRY_STRINGS[
          aRequestInfo.resourceNameOrOperationType?.operationType
        ] ??
        "unknown:" + aRequestInfo.resourceNameOrOperationType?.operationType,
      url: aRequestInfo.url,
      analysisType:
        this._ANALYSIS_TYPE_TELEMETRY_STRINGS[aRequestInfo.analysisType] ??
        "unknown:" + aRequestInfo.analysisType,
      reason:
        this._REASON_TELEMETRY_STRINGS[aRequestInfo.reason] ??
        "unknown:" + aRequestInfo.reason,
      ruleName: aResponse.ruleName || "",
    };
    if (aResponse.action === Ci.nsIContentAnalysisResponse.eWarn) {
      // The user hasn't made a choice yet; that's reported separately via
      // recordWarnResolution() once respondToWarnDialog() is called (either
      // from the warn dialog in ContentAnalysis.sys.mjs, or from the
      // downloads panel for download operations, which doesn't go through
      // that file at all).
      this._pendingWarnTelemetryInfo.set(
        aResponse.requestToken,
        requestDetails
      );
    }
    // A synthetic response is one Firefox generated itself rather than one an
    // agent sent. cancelError is only set on those when content analysis
    // failed (agent unreachable, timed out, ...), in which case the action
    // reflects browser.contentanalysis.default_result or timeout_result
    // rather than a verdict about the content. Firefox also synthesizes
    // responses for reasons that aren't failures, e.g. a URL matching
    // browser.contentanalysis.deny_url_regex_list, and those leave
    // cancelError at its eUserInitiated default.
    const isErrorFallback =
      aResponse.isSyntheticResponse &&
      aResponse.cancelError !== Ci.nsIContentAnalysisResponse.eUserInitiated;
    // Anywhere else cancelError is not meaningful, so report it as unset.
    const cancelError =
      isErrorFallback || isCancel
        ? (this._CANCEL_ERROR_TELEMETRY_STRINGS[aResponse.cancelError] ??
          "unknown:" + aResponse.cancelError)
        : "";
    this._record({
      ...requestDetails,
      action,
      cancelError,
      type: isErrorFallback ? "error_fallback" : "verdict",
      isCached: aResponse.isCachedResponse,
    });
  },

  /**
   * Records rule_triggered telemetry reporting how a warn verdict was
   * resolved (for either the warn dialog shown by ContentAnalysis.sys.mjs, or
   * the downloads panel's own warn UI). Called whenever
   * nsIContentAnalysis.respondToWarnDialog() is called, regardless of caller.
   *
   * @param {nsIContentAnalysisResponse} aResponse The resolved response;
   *   action will be eAllow or eBlock, never eWarn.
   * @param {string} aData The notification's data: "cancel" if the warn was
   *   resolved because the request was cancelled rather than because the user
   *   made a choice. See nsIContentAnalysis.respondToWarnDialog().
   * @param {boolean} aIsQuitting Whether the warn is being resolved because
   *   the application is quitting, in which case it's not a choice the user
   *   made even if aData isn't "cancel".
   */
  recordWarnResolution(aResponse, aData, aIsQuitting) {
    const pendingInfo = this._pendingWarnTelemetryInfo.get(
      aResponse.requestToken
    );
    if (!pendingInfo) {
      return;
    }
    this._pendingWarnTelemetryInfo.delete(aResponse.requestToken);
    const action =
      this._ACTION_TELEMETRY_STRINGS[aResponse.action] ??
      "unknown:" + aResponse.action;
    this._record({
      ...pendingInfo,
      action,
      type:
        aData === "cancel" || aIsQuitting ? "warn_cancel" : "warn_resolution",
    });
  },

  /**
   * Records a telemetry event for a content analysis (DLP) decision. Use
   * recordVerdict()/recordWarnResolution() instead of calling this directly.
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
  _record({
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
