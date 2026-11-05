/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  createEnterpriseLogger:
    "moz-src:///toolkit/components/enterprise/modules/EnterpriseCommon.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  return lazy.createEnterpriseLogger("FeltErrorWindowChild");
});

/**
 * Error-capture dedicated window actor. It is expected to be only setup on
 * matching pages like about:neterror/about:certerror and is there to pass the
 * error page URI information back to the parent-side of this window actor for
 * further processing, including extracting the error code to later display it
 * properly.
 *
 * It relies on inspecting the docShell that contains several nsIChannel:
 *  - failedChannel: this channel is related to the **real** URL that was trying
 *    to be accessed, i.e. the page that when loading triggered the error.
 *
 *  - currentDocumentChannel: this channel is related to the **loaded** content,
 *    so it is exactly what is needed here, since it holds the about: error
 *    page's URL.
 */
export class FeltErrorWindowChild extends JSWindowActorChild {
  handleEvent(aEvent) {
    if (aEvent.type !== "DOMContentLoaded") {
      lazy.log.error(`Unexpected aEvent.type=${aEvent.type}`);
      return;
    }

    lazy.log.debug(
      `Notify parent with errorPageURI: ${this.docShell.currentDocumentChannel.originalURI.spec}`
    );
    this.sendAsyncMessage("ErrorReport", {
      errorPageURI: this.docShell.currentDocumentChannel.originalURI.spec,
    });
  }
}
