/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

console.debug(`FeltExtension: FeltWindowChild.sys.mjs`);

/**
 *
 */
export class FeltWindowChild extends JSWindowActorChild {
  actorCreated() {
    this.actor = ChromeUtils.domProcessChild.getActor("FeltProcess");
  }

  handleEvent(event) {
    if (event.type !== "DOMContentLoaded") {
      console.error(`Unexpected event.type=${event.type}`);
      return;
    }

    console.debug("FeltWindowChild: Extracting token data");
    const consoleTokenData = JSON.parse(
      event.target.querySelector("#token_data").textContent
    );

    console.debug(
      "FeltWindowChild: Sending token data to ConsoleClient and starting Firefox"
    );
    this.actor.sendAsyncMessage("FeltChild:StartFirefox", consoleTokenData);
  }
}
