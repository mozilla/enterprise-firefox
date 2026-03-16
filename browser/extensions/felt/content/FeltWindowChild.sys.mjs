/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

console.debug(`FeltExtension: FeltWindowChild.sys.mjs`);

/**
 *
 */
export class FeltWindowChild extends JSWindowActorChild {
  #tokensSent = false;

  actorCreated() {
    this.processActor = ChromeUtils.domProcessChild.getActor("FeltProcess");
  }

  handleEvent(event) {
    if (event.type !== "DOMContentLoaded") {
      return;
    }
    this.#extractAndSendTokens(event.target);
  }

  receiveMessage(message) {
    if (message.name === "ExtractTokens") {
      return this.#extractAndSendTokens(this.document);
    }
    return false;
  }

  #extractAndSendTokens(doc) {
    if (this.#tokensSent) {
      return true;
    }

    const tokenData = doc.querySelector("#token_data");
    if (!tokenData) {
      return false;
    }

    console.debug("FeltWindowChild: Extracting token data");
    const consoleTokenData = JSON.parse(tokenData.textContent);
    if (
      consoleTokenData &&
      "access_token" in consoleTokenData &&
      consoleTokenData.access_token !== ""
    ) {
      console.debug("FeltWindowChild: Sending token data to start Firefox");
      this.#tokensSent = true;
      this.processActor.sendAsyncMessage(
        "FeltChild:StartFirefox",
        consoleTokenData
      );
      return true;
    }
    return false;
  }
}
