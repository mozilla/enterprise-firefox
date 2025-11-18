/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export const EnterpriseHandler = {
  /**
   * @typedef {object} User
   * @property {string} name name
   * @property {string} email email
   * @property {string} pictureUrl picture url
   */
  _signedInUser: null,

  async init(window) {
    await this.initUser();

    this.hideFxaToolbarButton(window);
    this.updateBadge(window);
  },

  async initUser() {
    const { ConsoleClient } = ChromeUtils.importESModule(
      "resource:///modules/enterprise/ConsoleClient.sys.mjs"
    );
    try {
      const { name, email, picture } =
        await ConsoleClient.getLoggedInUserInfo();
      this._signedInUser = { name, email, pictureUrl: picture };
    } catch (e) {
      console.warn(
        "EnterpriseHandler: Unable to initialize enterprise user: ",
        e
      );
    }
  },

  updateBadge(window) {
    const userIcon = window.document.querySelector("#enterprise-user-icon");

    if (!this._signedInUser) {
      // Hide user icon from enterprise badge
      userIcon.hidden = true;
      console.warn(
        "Unable to update user icon in badge without user information"
      );
      return;
    }
    userIcon.style.setProperty(
      "list-style-image",
      `url(${this._signedInUser.pictureUrl})`
    );
  },

  openPanel(element, event) {
    element.ownerGlobal.PanelUI.showSubView(
      "panelUI-enterprise",
      element,
      event
    );
    const document = element.ownerDocument;
    const email = document.querySelector(".panelUI-enterprise__email");

    if (!this._signedInUser) {
      email.hidden = true;
      document.querySelector("#PanelUI-enterprise-separator").hidden = true;
      console.warn(
        "Unable to update email in enterprise panel without user information"
      );
      return;
    }

    if (!email.textContent) {
      email.textContent = this._signedInUser.email;
    }
  },

  // TODO: FxA shows up in a lot of different areas. For now we hide the most prominent
  // toolbar button. How to hide or integrate with Fxa and Sync to be determined.
  hideFxaToolbarButton(window) {
    const fxaBtn = window.document.getElementById("fxa-toolbar-menu-button");
    fxaBtn.hidden = true;
  },

  // TODO: Open signout dialog
  onSignOut() {},
};
