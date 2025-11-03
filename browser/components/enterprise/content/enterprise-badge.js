/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/**
 * Signed in user
 */
class User {
  /**
   * @param {string} name
   * @param {string} email
   * @param {string} pictureUrl
   */
  constructor(name, email, pictureUrl) {
    this._name = name;
    this._email = email;
    this._pictureURL = pictureUrl;
  }

  get name() {
    return this._name;
  }

  set name(val) {
    this._name = val;
  }

  get email() {
    return this._email;
  }

  set email(val) {
    this._email = val;
  }

  get pictureURL() {
    return this._pictureURL;
  }

  set pictureURL(val) {
    this._pictureURL = val;
  }
}

const EnterpriseBadge = {
  _signedInUser: null,

  async init() {
    await this.initSignedInUser();
    this.onUpdateUserContent();
  },

  async initSignedInUser() {
    const { ConsoleClient } = ChromeUtils.importESModule(
      "resource:///modules/enterprise/ConsoleClient.sys.mjs"
    );
    const userInfo = await ConsoleClient.getLoggedInUserInfo();
    const { name, email, picture } = userInfo;
    this._signedInUser = new User(name, email, picture);
  },

  onUpdateUserContent() {
    document.getElementById("company__user").style["list-style-image"] =
      `url(${this._signedInUser.pictureURL})`;

    // Also hide fx account toolbar button
    document.getElementById("fxa-toolbar-menu-button").style.display = "none";
  },
};

document.addEventListener(
  "DOMContentLoaded",
  async () => {
    await EnterpriseBadge.init();
  },
  { once: true }
);
