/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { setTimeout } from "resource://gre/modules/Timer.sys.mjs";

export class FeltChild extends JSWindowActorChild {
  constructor() {
    super();
    // Notify ExtensionAPI side that we are loaded, we cannot do the
    // Services.cpmm calls within constructor but the setTimeout delays
    // enough that it works
    setTimeout(() => {
      Services.cpmm.addMessageListener("FeltMain:RedirectURL", this);
      Services.cpmm.sendAsyncMessage("FeltChild:Loaded", {});
    }, 0);
  }

  // Only handle DOMContentLoaded on https://sso.mozilla.com/dashboard
  handleEvent(event) {
    if (event.type !== "DOMContentLoaded") {
      console.error(`Unexpected event.type=${event.type}`);
      return;
    }

    this.sendAsyncMessage("FeltChild:StartFirefox", {});
  }

  receiveMessage(message) {
    switch (message.name) {
      case "FeltMain:RedirectURL":
        Services.cpmm.removeMessageListener("FeltMain:RedirectURL", this);
        this._redirect_url = message.data;
        break;

      case "FeltParent:Done":
        this.contentWindow.location.href = this._redirect_url;
        break;

      default:
        break;
    }
  }
}
