/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

const lazy = {};

import { ConsoleClient } from "resource:///modules/enterprise/ConsoleClient.sys.mjs";

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  let { ConsoleAPI } = ChromeUtils.importESModule(
    "resource://gre/modules/Console.sys.mjs"
  );
  return new ConsoleAPI({
    prefix: "EnterpriseAccountStorage",
    // tip: set maxLogLevel to "debug" and use log.debug() to create detailed
    // messages during development. See LOG_LEVELS in Console.sys.mjs for details.
    maxLogLevel: "debug",
    maxLogLevelPref: "browser.enterprise.loglevel",
  });
});

export class EnterpriseStorageManager {
  #data = Promise.reject("initialize not called");

  constructor(_options = {}) {
    lazy.log.debug("constructor");
  }

  // An initialization routine that *looks* synchronous to the callers, but
  // is actually async as everything else waits for it to complete.
  async initialize(_accountData) {
    lazy.log.debug("initialize");
    this.#data = ConsoleClient.getSyncAccountData();
  }

  finalize() {
    lazy.log.debug("StorageManager finalizing");
    lazy.log.debug("StorageManager finalized");
  }

  // Get the account data by combining the plain and secure storage.
  // If fieldNames is specified, it may be a string or an array of strings,
  // and only those fields are returned. If not specified the entire account
  // data is returned except for "in memory" fields. Note that not specifying
  // field names will soon be deprecated/removed - we want all callers to
  // specify the fields they care about.
  async getAccountData(_fieldNames = null) {
    lazy.log.debug("getAccountData");
    const data = await this.#data;
    return structuredClone(data);
  }

  // Update just the specified fields. This DOES NOT allow you to change to
  // a different user, nor to set the user as signed-out.
  async updateAccountData(_newFields) {
    lazy.log.debug("updateAccountData");
  }

  // Delete the data for an account - ie, called on "sign out".
  deleteAccountData() {
    lazy.log.debug("deleteAccountData");
    delete this._data;
  }
}
