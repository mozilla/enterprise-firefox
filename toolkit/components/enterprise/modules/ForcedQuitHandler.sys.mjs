/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  createEnterpriseLogger:
    "moz-src:///toolkit/components/enterprise/modules/EnterpriseCommon.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  return lazy.createEnterpriseLogger("ForcedQuitHandler");
});

const FORCED_QUIT_HOOK_CATEGORY = "enterprise-forced-quit-hook";
const FORCED_QUIT_HOOK_TIMEOUT_PREF =
  "enterprise.felt.forced_quit_hook_timeout_ms";
const FORCED_QUIT_HOOK_TIMEOUT_MS = 60000;

export const ForcedQuitHandler = {
  _forcedQuitHook: undefined,
  _quitPromise: null,
  _pendingQuitFlags: 0,

  /**
   * Resolves the application's forced-quit hook on first use. The hook
   * receives nsIAppStartup quit flags and must make every open window's
   * CanClose() check succeed before it settles. eForceQuit still checks
   * CanClose() and cancels the quit if a window refuses to close.
   *
   * @returns {?function(number): (void|Promise<void>)} The hook, or null if
   *   the application has none.
   */
  _appForcedQuitHook() {
    if (this._forcedQuitHook !== undefined) {
      return this._forcedQuitHook;
    }
    this._forcedQuitHook = null;
    for (const { value: url } of Services.catMan.enumerateCategory(
      FORCED_QUIT_HOOK_CATEGORY
    )) {
      try {
        this._forcedQuitHook = ChromeUtils.importESModule(url).beforeForcedQuit;
      } catch (e) {
        lazy.log.error(`Failed to load the forced-quit hook from ${url}:`, e);
      }
    }
    return this._forcedQuitHook;
  },

  /**
   * Requests a forced quit after the application's hook runs. Concurrent
   * requests share a promise and combine their quit flags.
   *
   * @param {number} [aFlags] - nsIAppStartup quit flags. Defaults to eForceQuit.
   * @returns {Promise<void>} Resolves after the quit request, even if vetoed.
   */
  quitIgnoringCanClose(aFlags = Ci.nsIAppStartup.eForceQuit) {
    if (Services.felt.isFeltUI()) {
      return Promise.reject(
        new Error(
          "quitIgnoringCanClose(): Called from Felt context, which is not allowed."
        )
      );
    }
    this._pendingQuitFlags |= aFlags;
    this._quitPromise ??= Promise.resolve().then(() => this._performQuit());
    return this._quitPromise;
  },

  async _performQuit() {
    const hook = this._appForcedQuitHook();
    if (hook) {
      const timeoutMs = Services.prefs.getIntPref(
        FORCED_QUIT_HOOK_TIMEOUT_PREF,
        FORCED_QUIT_HOOK_TIMEOUT_MS
      );
      let timeoutId;
      try {
        await Promise.race([
          hook(this._pendingQuitFlags),
          new Promise(resolve => {
            timeoutId = lazy.setTimeout(() => {
              lazy.log.error(
                `Pre-forced-quit hook did not settle within ${timeoutMs}ms; quitting anyway.`
              );
              resolve();
            }, timeoutMs);
          }),
        ]);
      } catch (error) {
        lazy.log.error("Pre-forced-quit hook failed; quitting anyway.", error);
      } finally {
        lazy.clearTimeout(timeoutId);
      }
    }
    Services.startup.quit(this._pendingQuitFlags);
    if (!Services.startup.shuttingDown) {
      this._quitPromise = null;
      this._pendingQuitFlags = 0;
    }
  },
};
