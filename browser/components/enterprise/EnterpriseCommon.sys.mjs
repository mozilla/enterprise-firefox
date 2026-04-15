/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const IS_TESTING_ENVIRONMENT = "enterprise.is_testing";
const IS_BLOCKING_SHUTDOWN = "enterprise.felt_tests.is_blocking_shutdown";
const IS_UPDATES_TESTING = "enterprise.felt_tests.is_updates_testing";
const SHOULD_NOT_CLOSE_WINDOW = "enterprise.felt_tests.should_not_close_window";

export const isTesting = () => {
  return Services.prefs.getBoolPref(IS_TESTING_ENVIRONMENT, false);
};

export const isUpdatesTesting = () => {
  return Services.prefs.getBoolPref(IS_UPDATES_TESTING, false);
};

export const isBlockingShutdown = () => {
  return Services.prefs.getBoolPref(IS_BLOCKING_SHUTDOWN, false);
};

export const shouldNotCloseWindow = () => {
  return Services.prefs.getBoolPref(SHOULD_NOT_CLOSE_WINDOW, false);
};

const ENTERPRISE_LOG_LEVEL_PREF = "enterprise.log_level";

export const EnterpriseCommon = {
  ENTERPRISE_DEVICE_ID_PREF: "enterprise.sync.device_id",
};

export function createEnterpriseLogger(logPrefix) {
  return console.createInstance({
    prefix: logPrefix,
    maxLogLevelPref: ENTERPRISE_LOG_LEVEL_PREF,
  });
}
