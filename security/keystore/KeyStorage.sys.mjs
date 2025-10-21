/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

export var KeyStorage = {
  init() {
    // Load the PK11 token
    const tokenDB = Cc["@mozilla.org/security/pk11tokendb;1"].getService(
      Ci.nsIPK11TokenDB
    );

    let pk11token;
    try {
      pk11token = tokenDB.getInternalKeyToken();
    } catch (e) {
      console.error("KeyStorage.init: Error getting PK11 token: " + e);
      return;
    }

    try {
      pk11token.login(true);
    } catch (e) {
      console.error(
        "KeyStorage.init: Error getting logging in PK11 token: " + e
      );
    }
  },
};
