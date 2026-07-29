/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Shim module for Content Analysis Telemetry.
 *
 * This module provides a stable import path for content analysis (DLP)
 * telemetry functionality. The actual implementation is conditionally
 * provided at build time:
 * - In MOZ_ENTERPRISE builds: Full enterprise telemetry implementation
 * - In regular builds: No-op implementation (enterprise code completely absent)
 */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

let ContentAnalysisTelemetryImpl = {
  recordVerdict: () => {},
  recordWarnResolution: () => {},
  reset: () => {},
};

if (AppConstants.MOZ_ENTERPRISE) {
  try {
    const { ContentAnalysisTelemetryEnterprise } = ChromeUtils.importESModule(
      "moz-src:///browser/components/contentanalysis/content/ContentAnalysisTelemetry.enterprise.sys.mjs"
    );
    ContentAnalysisTelemetryImpl = ContentAnalysisTelemetryEnterprise;
  } catch (ex) {
    console.error(
      "[ContentAnalysisTelemetry] Enterprise implementation not available, using no-op shim. Error:",
      ex.message
    );
  }
}

export const ContentAnalysisTelemetry = ContentAnalysisTelemetryImpl;
