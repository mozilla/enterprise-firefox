/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  AccessConnectorButton:
    "moz-src:///browser/components/ipprotection/enterprise/AccessConnectorButton.sys.mjs",
  EveryWindow: "resource:///modules/EveryWindow.sys.mjs",
});

const WINDOW_CALLBACK_ID = "access-connector-button";

/**
 * AccessConnectorClass is the class for the singleton AccessConnector, the
 * enterprise counterpart to IPProtection.
 *
 * It creates an AccessConnectorButton for every browser window and removes
 * it when the window closes.
 */
class AccessConnectorClass {
  #inited = false;
  #buttons = new WeakMap();

  /**
   * Creates a button for every current and future browser window.
   */
  init() {
    if (this.#inited) {
      return;
    }
    this.#inited = true;

    lazy.EveryWindow.registerCallback(
      WINDOW_CALLBACK_ID,
      win => this.#onWindowOpened(win),
      win => this.onWindowClosed(win)
    );
  }

  /**
   * Removes the button from every window.
   */
  uninit() {
    if (!this.#inited) {
      return;
    }
    // The uninit callbacks run asynchronously and remove each window's button.
    lazy.EveryWindow.unregisterCallback(WINDOW_CALLBACK_ID);
    this.#inited = false;
  }

  /**
   * Returns the initialization status
   */
  get isInitialized() {
    return this.#inited;
  }

  /**
   * Get the AccessConnectorButton for a given window.
   *
   * @param {Window} window - which window to get the button for.
   * @returns {AccessConnectorButton|undefined}
   */
  getButton(window) {
    return this.#buttons.get(window);
  }

  /**
   * @param {Window} window - the window being opened.
   */
  #onWindowOpened(window) {
    if (!this.#buttons.has(window)) {
      this.#buttons.set(window, new lazy.AccessConnectorButton(window));
    }
  }

  /**
   * Uninits and forgets the button for a closed window.
   *
   * @param {Window} window - the window being closed.
   */
  onWindowClosed(window) {
    this.#buttons.get(window)?.uninit();
    this.#buttons.delete(window);
  }
}

const AccessConnector = new AccessConnectorClass();

export { AccessConnector };
