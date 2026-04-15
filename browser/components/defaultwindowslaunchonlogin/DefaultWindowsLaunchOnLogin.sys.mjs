/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

export const DEFAULT_WINDOWS_LAUNCH_ON_LOGIN_NIMBUS_FEATURE_ID =
  "defaultWindowsLaunchOnLogin";

const lazy = XPCOMUtils.declareLazy({
  ClientEnvironmentBase:
    "resource://gre/modules/components-utils/ClientEnvironment.sys.mjs",
  WindowsLaunchOnLogin: "resource://gre/modules/WindowsLaunchOnLogin.sys.mjs",
  NimbusFeatures: "resource://nimbus/ExperimentAPI.sys.mjs",
});

export var DefaultWindowsLaunchOnLogin = {
  async firstStartupNewProfile() {
    if (!lazy.ClientEnvironmentBase.os.isWindows) {
      return;
    }

    this.logger.debug(
      "First startup with a new profile - checking to enable launch on login by default"
    );

    const nimbusFeature =
      lazy.NimbusFeatures[DEFAULT_WINDOWS_LAUNCH_ON_LOGIN_NIMBUS_FEATURE_ID];
    await nimbusFeature.ready();
    const { enabled } = nimbusFeature.getAllVariables({
      defaultValues: { enabled: false },
    });

    if (!enabled) {
      this.logger.debug("   - Nimbus said no");
      return;
    }

    let approval = await lazy.WindowsLaunchOnLogin.getLaunchOnLoginApproved();
    if (!approval) {
      this.logger.debug("   - Windows policy denied");
      return;
    }

    nimbusFeature.recordExposureEvent({ once: true });

    await lazy.WindowsLaunchOnLogin.createLaunchOnLogin();
    this.logger.debug("   - enabled");
  },

  logger: console.createInstance({
    prefix: "DefaultWindowsLaunchOnLogin",
    maxLogLevel: "Debug",
  }),
};
