/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

console.debug(`FeltExtension: FeltErrorWindowChild.sys.mjs`);

/**
 *
 */
export class FeltErrorWindowChild extends JSWindowActorChild {
  actorCreated() {
    console.debug(`FeltExtension: FeltErrorWindowChild: actorCreated()`);
  }

  handleEvent(aEvent) {
    console.debug(
      `FeltExtension: FeltErrorWindowChild: handleEvent(): aEvent.type=${aEvent.type}`
    );

    if (aEvent.type !== "DOMContentLoaded") {
      console.error(`Unexpected aEvent.type=${aEvent.type}`);
      return;
    }

    // Documents have a null ownerDocument.
    let doc = aEvent.originalTarget.ownerDocument || aEvent.originalTarget;
    console.debug(
      `FeltExtension: FeltErrorWindowChild: handleEvent(): docShell.loadType:${this.docShell.loadType}`
    );
    console.debug(
      `FeltExtension: FeltErrorWindowChild: handleEvent(): docShell.failedChannel.URI:${this.docShell.failedChannel.URI?.spec}`
    );
    console.debug(
      `FeltExtension: FeltErrorWindowChild: handleEvent(): docShell.failedChannel.originalURI:${this.docShell.failedChannel.originalURI?.spec}`
    );
    console.debug(
      `FeltExtension: FeltErrorWindowChild: handleEvent(): docShell.currentDocumentChannel.URI:${this.docShell.currentDocumentChannel.URI?.spec}`
    );
    console.debug(
      `FeltExtension: FeltErrorWindowChild: handleEvent(): docShell.currentDocumentChannel.originalURI:${this.docShell.currentDocumentChannel.originalURI?.spec}`
    );

    this.sendAsyncMessage("FeltErrorWindow", {
      errorPage: this.docShell.currentDocumentChannel.originalURI.spec,
    });
  }
}
