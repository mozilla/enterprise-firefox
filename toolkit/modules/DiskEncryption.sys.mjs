/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

const DEFAULT_TIMEOUT_MS = 30000;

const UNKNOWN = Object.freeze({ status: "unknown", method: null });
const VALID_STATUSES = new Set([
  "full",
  "enabled",
  "partial",
  "disabled",
  "in-progress",
]);
const VALID_METHODS = new Set(["filevault", "bitlocker", "dm-crypt", "zfs"]);

/**
 * @typedef {object} DiskEncryptionStatus
 * @property {"full"|"enabled"|"partial"|"disabled"|"in-progress"|"unknown"} status
 *   Aggregated encryption status.
 * @property {"filevault"|"bitlocker"|"dm-crypt"|"zfs"|null} method
 *   Platform mechanism checked, or null for an unknown status.
 */

export const DiskEncryption = {
  /**
   * Returns the machine's disk encryption status, or "unknown" if detection
   * fails or times out.
   *
   * @param {number} [timeoutMs]
   *   Maximum wait in milliseconds.
   * @returns {Promise<DiskEncryptionStatus>}
   */
  getStatus(timeoutMs = DEFAULT_TIMEOUT_MS) {
    return new Promise(resolve => {
      let timer = null;
      let settled = false;
      const finish = result => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          lazy.clearTimeout(timer);
        }
        resolve(result);
      };

      timer = lazy.setTimeout(() => {
        console.warn("Disk encryption detection timed out; reporting unknown.");
        finish(UNKNOWN);
      }, timeoutMs);

      try {
        Cc["@mozilla.org/enterprise/disk-encryption-checker;1"]
          .getService()
          .QueryInterface(Ci.nsIDiskEncryptionChecker)
          .getDiskEncryption({
            QueryInterface: ChromeUtils.generateQI([
              Ci.nsIDiskEncryptionCheckerCallback,
            ]),
            onComplete(status, method) {
              if (!VALID_STATUSES.has(status) || !VALID_METHODS.has(method)) {
                finish(UNKNOWN);
                return;
              }
              finish({ status, method });
            },
          });
      } catch (e) {
        finish(UNKNOWN);
      }
    });
  },
};
