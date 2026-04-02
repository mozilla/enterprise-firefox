/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

import { IPPAuthProvider } from "moz-src:///toolkit/components/ipprotection/IPPAuthProvider.sys.mjs";

const lazy = {};

ChromeUtils.defineLazyGetter(lazy, "fxAccounts", () =>
  ChromeUtils.importESModule(
    "resource://gre/modules/FxAccounts.sys.mjs"
  ).getFxAccountsSingleton()
);
ChromeUtils.defineESModuleGetters(lazy, {
  IPPEnrollAndEntitleManager:
    "moz-src:///toolkit/components/ipprotection/fxa/IPPEnrollAndEntitleManager.sys.mjs",
  IPPSignInWatcher:
    "moz-src:///toolkit/components/ipprotection/fxa/IPPSignInWatcher.sys.mjs",
});

/**
 * FxA implementation of IPPAuthProvider. Handles OAuth token retrieval,
 * enrollment via Guardian, and FxA-specific proxy bypass rules.
 */
class IPPFxaAuthProviderSingleton extends IPPAuthProvider {
  get helpers() {
    return [lazy.IPPSignInWatcher, lazy.IPPEnrollAndEntitleManager];
  }

  get isReady() {
    // For non authenticated users, we don't know yet their enroll state so the UI
    // is shown and they have to login.
    if (!lazy.IPPSignInWatcher.isSignedIn) {
      return false;
    }

    // If the current account is not enrolled and entitled, the UI is shown and
    // they have to opt-in.
    // If they are currently enrolling, they have already opted-in.
    if (
      !lazy.IPPEnrollAndEntitleManager.isEnrolledAndEntitled &&
      !lazy.IPPEnrollAndEntitleManager.isEnrolling
    ) {
      return false;
    }

    return true;
  }

  /**
   * Retrieves an FxA OAuth token and returns a disposable handle that revokes
   * it on disposal.
   *
   * @param {AbortSignal} [abortSignal]
   * @returns {Promise<{token: string} & Disposable>}
   */
  async getToken(abortSignal = null) {
    if (AppConstants.MOZ_ENTERPRISE) {
      return {
        token: Services.felt.getAccessTokenIfValid(),
        [Symbol.dispose]: () => {},
      };
    }
    let tasks = [
      lazy.fxAccounts.getOAuthToken({
        scope: ["profile", "https://identity.mozilla.com/apps/vpn"],
      }),
    ];
    if (abortSignal) {
      abortSignal.throwIfAborted();
      tasks.push(
        new Promise((_, rej) => {
          abortSignal?.addEventListener("abort", rej, { once: true });
        })
      );
    }
    const token = await Promise.race(tasks);
    if (!token) {
      return null;
    }
    return {
      token,
      [Symbol.dispose]: () => {
        lazy.fxAccounts.removeCachedOAuthToken({ token });
      },
    };
  }

  async aboutToStart() {
    let result;
    if (lazy.IPPEnrollAndEntitleManager.isEnrolling) {
      result = await lazy.IPPEnrollAndEntitleManager.waitForEnrollment();
    }
    if (!lazy.IPPEnrollAndEntitleManager.isEnrolledAndEntitled) {
      return { error: result?.error };
    }
    return null;
  }

  get excludedUrlPrefs() {
    return [
      "identity.fxaccounts.remote.profile.uri",
      "identity.fxaccounts.auth.uri",
    ];
  }
}

const IPPFxaAuthProvider = new IPPFxaAuthProviderSingleton();

export { IPPFxaAuthProvider };
