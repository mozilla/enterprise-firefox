/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  createEnterpriseLogger:
    "moz-src:///toolkit/components/enterprise/modules/EnterpriseCommon.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  return lazy.createEnterpriseLogger("FeltCommon");
});

export const FeltCommon = {
  PRIVATE_BROWSING_ID: 1,
  ENTERPRISE_PROFILE: `enterprise-profile-${AppConstants.MOZ_UPDATE_CHANNEL}`,
  POLICY_POLLING_FREQUENCY: 60_000,
};

/**
 * Derives the managed-profile name for a user id: a stable, non-reversible
 * per-user profile name.
 *
 * @param {string|null} userId
 * @returns {Promise<string>}
 */
export async function getProfileName(userId) {
  if (userId != null) {
    return `${FeltCommon.ENTERPRISE_PROFILE}-${await hashTo40bits(userId)}`;
  }
  lazy.log.error(`No user id for profile derivation; using shared profile`);
  return FeltCommon.ENTERPRISE_PROFILE;
}

/**
 * Resolves the managed profile for the signed-in user, creating it if it does not
 * exist yet. An enterprise.profile_path override has no registered profile.
 *
 * @param {{id: string}|null} loggedInUserInfo
 * @returns {Promise<{profile: nsIToolkitProfile|null, path: string}>} The
 *   registered profile, if any, and the absolute path to its directory.
 */
export async function resolveManagedProfile(loggedInUserInfo) {
  let profilePath = Services.prefs.getStringPref("enterprise.profile_path", "");
  let foundProfile = null;

  if (!profilePath) {
    let profileService = Cc[
      "@mozilla.org/toolkit/profile-service;1"
    ].getService(Ci.nsIToolkitProfileService);

    let profileName = await getProfileName(loggedInUserInfo?.id ?? null);

    for (let profile of profileService.profiles) {
      if (profile.name === profileName) {
        foundProfile = profile;
        break;
      }
    }

    if (!foundProfile) {
      lazy.log.debug(`creating new ${profileName} profile`);
      foundProfile = profileService.createProfile(
        null,
        profileName,
        "felt-firstrun"
      );

      await profileService.asyncFlush();
    }

    profilePath = foundProfile.rootDir.path;
  } else if (Services.appinfo.OS == "WINNT") {
    profilePath = PathUtils.normalize(profilePath.replaceAll("/", "\\"));
  }

  return { profile: foundProfile, path: profilePath };
}

async function hashTo40bits(s) {
  const msgUint8 = new TextEncoder().encode(s);
  const hashBuffer = await globalThis.crypto.subtle.digest("SHA-256", msgUint8);
  const base64 = new Uint8Array(hashBuffer).slice(0, 5).toBase64({
    omitPadding: true,
    alphabet: "base64url",
  });
  return base64;
}
