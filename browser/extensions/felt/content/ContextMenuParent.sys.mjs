/* vim: set ts=2 sw=2 sts=2 et tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Displays the context menu in the parent in response to a request from the child.
 */
export class ContextMenuParent extends JSWindowActorParent {
  receiveMessage(message) {
    let browser = this.manager.rootFrameLoader.ownerElement;
    if (browser.hasAttribute("disablecontextmenu")) {
      return;
    }

    let win = browser.ownerGlobal;
    this.#openContextMenu(message.data, win);
  }

  #showItem(id, show) {
    var item =
      this.manager.rootFrameLoader.ownerElement.ownerDocument.getElementById(
        id
      );
    if (item) {
      item.hidden = !show;
    }
  }

  /**
   * Handles opening of the context menu for the appropriate browser.
   *
   * @param {object} data
   *   The data for the context menu, received from the child.
   * @param {DOMWindow} win
   *   The window in which the context menu is to be opened.
   */
  #openContextMenu(data, win) {
    win.goUpdateGlobalEditMenuItems();

    // Not yet implemented, bug 2012420
    this.#showItem("textbox-contextmenu-reveal-password", false);

    // We don't have access to the original event here, as that happened in
    // another process. Therefore we synthesize a new MouseEvent to propagate the
    // inputSource to the subsequently triggered popupshowing event.
    let newEvent = new PointerEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      screenX: data.screenXDevPx / win.devicePixelRatio,
      screenY: data.screenYDevPx / win.devicePixelRatio,
      button: 2,
      pointerType: (() => {
        switch (data.inputSource) {
          case MouseEvent.MOZ_SOURCE_MOUSE:
            return "mouse";
          case MouseEvent.MOZ_SOURCE_PEN:
            return "pen";
          case MouseEvent.MOZ_SOURCE_ERASER:
            return "eraser";
          case MouseEvent.MOZ_SOURCE_CURSOR:
            return "cursor";
          case MouseEvent.MOZ_SOURCE_TOUCH:
            return "touch";
          case MouseEvent.MOZ_SOURCE_KEYBOARD:
            return "keyboard";
          default:
            return "";
        }
      })(),
    });

    let popup = win.document.getElementById("textbox-contextmenu");
    popup.openPopupAtScreen(newEvent.screenX, newEvent.screenY, true, newEvent);
  }
}
