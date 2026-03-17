/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

console.warn("[FeltWindowChild] Module loaded");

/**
 *
 */
export class FeltWindowChild extends JSWindowActorChild {
  actorCreated() {
    console.warn(
      `[FeltWindowChild] actorCreated, ` +
        `browsingContext=${this.browsingContext?.id}, ` +
        `uri=${this.document?.documentURI}`
    );
    try {
      this.actor = ChromeUtils.domProcessChild.getActor("FeltProcess");
      console.warn(`[FeltWindowChild] Got FeltProcess actor: ${!!this.actor}`);
    } catch (e) {
      console.warn(`[FeltWindowChild] FAILED to get FeltProcess actor: ${e}`);
    }
  }

  handleEvent(event) {
    console.warn(
      `[FeltWindowChild] handleEvent: type=${event.type}, ` +
        `uri=${event.target?.documentURI || "(unknown)"}`
    );
    if (event.type !== "DOMContentLoaded") {
      return;
    }

    const tokenData = event.target.querySelector("#token_data");
    if (!tokenData) {
      console.warn(
        `[FeltWindowChild] No #token_data on page, ` +
          `readyState=${event.target.readyState}, ` +
          `bodyLen=${event.target.body?.innerHTML?.length ?? "N/A"}`
      );
      return;
    }

    console.warn(
      `[FeltWindowChild] Found #token_data, ` +
        `length=${tokenData.textContent?.length}`
    );
    const consoleTokenData = JSON.parse(tokenData.textContent);
    if (
      consoleTokenData &&
      "access_token" in consoleTokenData &&
      consoleTokenData.access_token !== ""
    ) {
      console.warn("[FeltWindowChild] Sending FeltChild:StartFirefox");
      this.actor.sendAsyncMessage("FeltChild:StartFirefox", consoleTokenData);
      console.warn("[FeltWindowChild] Message sent");
    } else {
      console.warn(
        `[FeltWindowChild] Token data invalid: ` +
          `keys=${Object.keys(consoleTokenData || {})}`
      );
    }
  }

  didDestroy() {
    console.warn(
      `[FeltWindowChild] didDestroy, ` +
        `browsingContext=${this.browsingContext?.id}`
    );
  }
}
