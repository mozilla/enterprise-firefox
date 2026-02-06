/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  SpellCheckHelper: "resource://gre/modules/InlineSpellChecker.sys.mjs",
});

/**
 * Gathers the data required to display the context menu from the content process.
 */
export class ContextMenuChild extends JSWindowActorChild {
  handleEvent(event) {
    switch (event.type) {
      case "contextmenu":
        this.#onContextMenu(event);
        break;
      default:
        console.error(`ContextMenuChild: Unexpected event.type=${event.type}`);
        break;
    }
  }

  #onContextMenu(event) {
    // Prevent the default context menu from showing up immediately.
    event.preventDefault();

    let editFlags = lazy.SpellCheckHelper.isEditable(
      event.composedTarget,
      this.contentWindow
    );

    if ((editFlags & lazy.SpellCheckHelper.TEXTINPUT) == 0) {
      return;
    }

    // Set the event target so command controllers know what to operate on.
    // Then update commands to send state (including undo/redo availability)
    // to the parent process.
    this.docShell.docViewer
      .QueryInterface(Ci.nsIDocumentViewerEdit)
      .setCommandNode(event.composedTarget);
    event.composedTarget.ownerGlobal.updateCommands("contentcontextmenu");

    this.sendAsyncMessage("FeltChild:ContextMenu", {
      onPasswordInput: (editFlags & lazy.SpellCheckHelper.PASSWORD) !== 0,
      screenXDevPx: event.screenX * this.contentWindow.devicePixelRatio,
      screenYDevPx: event.screenY * this.contentWindow.devicePixelRatio,
      inputSource: event.inputSource,
    });
  }
}
