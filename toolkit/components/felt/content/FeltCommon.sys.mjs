/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  createEnterpriseLogger:
    "resource://gre/modules/enterprise/EnterpriseCommon.sys.mjs",
});

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  return lazy.createEnterpriseLogger("FeltCommon");
});

export const FeltCommon = {
  PRIVATE_BROWSING_ID: 1,
  ENTERPRISE_PROFILE: `enterprise-profile-${AppConstants.MOZ_UPDATE_CHANNEL}`,
  POLICY_POLLING_FREQUENCY: 60_000,
};

async function getProfileName(userId) {
  if (userId !== null) {
    return `${FeltCommon.ENTERPRISE_PROFILE}-${await hashTo40bits(userId)}`;
  }
  lazy.log.error(`loggedInUserInfo not set`);
  return FeltCommon.ENTERPRISE_PROFILE;
}

export async function GetProfilePath(loggedInUserInfo) {
  let profilePath = Services.prefs.getStringPref("enterprise.profile_path", "");

  if (!profilePath) {
    let profileService = Cc[
      "@mozilla.org/toolkit/profile-service;1"
    ].getService(Ci.nsIToolkitProfileService);

    let profileName = await getProfileName(loggedInUserInfo?.id);
    let foundProfile = null;

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

  return profilePath;
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
