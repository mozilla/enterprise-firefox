/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Wraps the callback-based EDR-checker XPCOM API
// (@mozilla.org/enterprise/edr-checker;1) in a Promise and bounds the wait, so
// a hung probe or a lost callback can never stall the caller.

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

// Default upper bound on detection, after which we report none present.
const DEFAULT_TIMEOUT_MS = 30000;

export const EdrDetection = {
  /**
   * Resolves to the string identifiers of the EDR agents detected on the client.
   *
   * @param {string[]} [requestedIds]
   *   Identifiers of the agents to probe; an empty list asks for every agent the
   *   build knows about. The catalog lives in the EDR-checker component.
   * @param {number} [timeoutMs]
   *   Upper bound on the wait; on timeout the promise resolves to an empty array.
   * @returns {Promise<string[]>}
   */
  getPresentEdrs(requestedIds = [], timeoutMs = DEFAULT_TIMEOUT_MS) {
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
        console.warn("EDR detection timed out; reporting none present.");
        finish([]);
      }, timeoutMs);

      try {
        Cc["@mozilla.org/enterprise/edr-checker;1"]
          .getService()
          .QueryInterface(Ci.nsIEdrChecker)
          .getPresentEdrs(requestedIds, {
            QueryInterface: ChromeUtils.generateQI([Ci.nsIEdrCheckerCallback]),
            onComplete(presentEdrs) {
              finish(Array.from(presentEdrs));
            },
          });
      } catch (e) {
        finish([]);
      }
    });
  },
};
