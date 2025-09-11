/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export const FeltCommon = {
  defineLogGetter(logPrefix) {
    let { ConsoleAPI } = ChromeUtils.importESModule(
      "resource://gre/modules/Console.sys.mjs"
    );
    return new ConsoleAPI({
      maxLogLevelPref: "extensions.felt.loglevel",
      prefix: logPrefix,
    });
  },
};
