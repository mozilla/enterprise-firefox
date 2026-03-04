/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

console.debug(`FeltExtension: FeltWindowChild.sys.mjs`);

/**
 *
 */
export class FeltWindowChild extends JSWindowActorChild {
  constructor() {
    console.debug(`FeltExtension: FeltWindowChild: constructor()`);
    super();
  }

  actorCreated() {
    console.debug(`FeltExtension: FeltWindowChild: actorCreated`);
    this.actor = ChromeUtils.domProcessChild.getActor("FeltProcess");
  }

  handleEvent(event) {
    console.debug(`FeltExtension: FeltWindowChild: event.type=${event.type}`);

    if (event.type !== "DOMContentLoaded") {
      console.error(`Unexpected event.type=${event.type}`);
      return;
    }

    const tokenData = event.target.querySelector("#token_data");
    if (tokenData) {
      console.debug("FeltWindowChild: Extracting token data");
      const consoleTokenData = JSON.parse(tokenData.textContent);
      if (
        consoleTokenData &&
        "access_token" in consoleTokenData &&
        consoleTokenData.access_token !== ""
      ) {
        console.debug(
          "FeltWindowChild: Sending token data to ConsoleClient and starting Firefox"
        );
        this.actor.sendAsyncMessage("FeltChild:StartFirefox", consoleTokenData);
      }
    }
  }
}
