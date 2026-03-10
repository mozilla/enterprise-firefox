/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

console.debug(`FeltExtension: FeltErrorWindowParent.sys.mjs`);

/**
 *
 */
export class FeltErrorWindowParent extends JSWindowActorParent {
  actorCreated() {
    console.debug(`FeltExtension: FeltErrorWindowParent: actorCreated()`);
  }

  get browser() {
    return this.browsingContext.top.embedderElement;
  }

  receiveMessage(message) {
    console.debug(
      `FeltExtension: FeltErrorWindowParent: Received message ${message.name} => ${message.data}`
    );
    switch (message.name) {
      case "FeltErrorWindow":
        console.debug(
          `FeltExtension: FeltErrorWindowParent: browser:${this.browser}`
        );
        const errorEv = new this.browser.ownerGlobal.CustomEvent("FeltError", {
          detail: message.data,
          bubbles: true,
          cancelable: false,
        });
        console.debug(
          `FeltExtension: FeltErrorWindowParent: errorEv:${errorEv}`
        );
        this.browser.dispatchEvent(errorEv);
        break;
    }
  }
}
