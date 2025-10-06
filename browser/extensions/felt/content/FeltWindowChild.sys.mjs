/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

console.debug(`FeltExtension: FeltWindowChild.sys.mjs`);

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ConsoleClient: "chrome://felt/content/ConsoleClient.sys.mjs",
});

/**
 *
 */
export class FeltWindowChild extends JSWindowActorChild {
  actorCreated() {
    console.debug(
      `FeltExtension: FeltParent.sys.mjs: FeltWindowChild: getActor()`
    );
    this.actor = ChromeUtils.domProcessChild.getActor("FeltProcess");
    console.debug(
      `FeltExtension: FeltParent.sys.mjs: FeltWindowChild: getActor(): actor=${this.actor}`
    );
  }

  handleEvent(event) {
    if (event.type !== "DOMContentLoaded") {
      console.error(`Unexpected event.type=${event.type}`);
      return;
    }

    console.debug("Extracting token data");
    const consoleTokenData = JSON.parse(
      event.target.querySelector("#token_data").textContent
    );

    console.debug("Sending token data to ConsoleClient");
    lazy.ConsoleClient.onConsoleTokenDataReceived(consoleTokenData);

    this.actor.sendAsyncMessage("FeltChild:StartFirefox", {
      access_token: lazy.ConsoleClient.consoleTokenData.accessToken,
    });
  }
}
