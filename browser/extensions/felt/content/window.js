/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { E10SUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/E10SUtils.sys.mjs"
);

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ConsoleClient: "resource:///modules/enterprise/ConsoleClient.sys.mjs",
  FeltCommon: "chrome://felt/content/FeltCommon.sys.mjs",
  FeltStorage: "resource:///modules/FeltStorage.sys.mjs",
  PopupNotifications: "resource://gre/modules/PopupNotifications.sys.mjs",
});

// Will at least make move forward marionette
Services.obs.notifyObservers(window, "browser-delayed-startup-finished");

const ErrorReport = {
  _wrapper: null,

  init() {
    this._wrapper = document.querySelector(".felt-browser-error");
  },

  reset() {
    if (!this._wrapper) {
      return;
    }
    if (this._wrapper.classList.contains("is-hidden")) {
      return;
    }
    this._wrapper.classList.add("is-hidden");
    const errors = this._wrapper.querySelectorAll(
      ".felt-browser-error > div:not(.is-hidden)"
    );
    errors.forEach(e => e.classList.add("is-hidden"));
  },

  async update(errorType, details = null) {
    if (!this._wrapper) {
      return;
    }
    const errorElement = this._wrapper.querySelector(`.${errorType}`);
    if (!errorElement) {
      return;
    }
    if (details) {
      const detailsElement = errorElement.querySelector(
        ".felt-browser-error-details"
      );
      if (detailsElement) {
        const l10nId = `felt-error-${details}`;
        const translated = await document.l10n.formatValue(l10nId);
        detailsElement.textContent = translated || details;
      }
    }
    errorElement.classList.remove("is-hidden");
    this._wrapper.classList.remove("is-hidden");
  },
};

async function connectToConsole(email) {
  ErrorReport.reset();

  let posture;
  try {
    posture = await lazy.ConsoleClient.sendDevicePosture();
  } catch (err) {
    console.error(`FeltExtension: Failed to connect to console: ${err}`);
    ErrorReport.update("felt-browser-error-connection", err.message);
    return;
  }

  if (!posture) {
    // TODO: Currently we don't check the posture yet. In the future we need to handle rejected device posture
    return;
  }

  let browser = document.getElementById("browser");

  let oa = E10SUtils.predictOriginAttributes({ browser });
  browser.setAttribute("maychangeremoteness", "true");

  const ssoLoginURI = lazy.ConsoleClient.constructSsoLoginURI(
    email,
    posture.posture
  );

  browser.setAttribute(
    "remoteType",
    E10SUtils.getRemoteTypeForURI(
      ssoLoginURI.spec,
      /* remote */ true,
      /* fission */ true,
      E10SUtils.WEB_REMOTE_TYPE,
      null,
      oa
    )
  );
  console.debug(
    `FeltExtension: creating contentPrincipal with privateBrowsingId=${lazy.FeltCommon.PRIVATE_BROWSING_ID}`
  );
  const contentPrincipal =
    Services.scriptSecurityManager.createContentPrincipal(ssoLoginURI, {
      privateBrowsingId: lazy.FeltCommon.PRIVATE_BROWSING_ID,
    });
  console.debug(
    `FeltExtension: created contentPrincipal with privateBrowsingId=${contentPrincipal.privateBrowsingId}`
  );
  console.debug("Load SSO URI: ", ssoLoginURI);
  browser.fixupAndLoadURIString(ssoLoginURI.spec, {
    triggeringPrincipal: contentPrincipal,
  });

  document.querySelector(".felt-login__email-pane").classList.add("is-hidden");
  document.querySelector(".felt-login__sso").classList.remove("is-hidden");

  const ssoBrowsingContext = document.querySelector("browser");
  ssoBrowsingContext.focus();
}

async function listenFormEmailSubmission() {
  const signInBtn = document.getElementById("felt-form__sign-in-btn");
  const emailInput = document.getElementById("felt-form__email");

  const lastUsedUserEmail = lazy.FeltStorage.getLastSignedInUser();
  if (lastUsedUserEmail) {
    emailInput.value = lastUsedUserEmail;
    signInBtn.disabled = false;
  }

  emailInput.addEventListener("input", () => {
    signInBtn.disabled = emailInput.value.trim() === "";
  });

  emailInput.focus();

  // <moz-button> does not trigger the native "submit" event on <form>
  // so we manually handle submission on button click and when Enter is pressed
  signInBtn.addEventListener("click", () => {
    connectToConsole(emailInput.value);
  });
  emailInput.addEventListener("keydown", e => {
    if (e.key === "Enter" && !signInBtn.disabled) {
      e.preventDefault();
      connectToConsole(emailInput.value);
    }
  });
}

function informAboutPotentialStartupFailure() {
  if (window.location.search) {
    const errorClass = new URLSearchParams(window.location.search).get("error");
    if (errorClass) {
      ErrorReport.update(errorClass);
    }
  }
}

function setupMarionetteEnvironment() {
  window.fullScreen = false;

  window.FullScreen = {
    exitDomFullScreen() {},
  };

  window.gBrowser = {
    get selectedBrowser() {
      let rv = document.getElementById("browser");
      return rv;
    },

    get tabs() {
      let ts = [
        {
          linkedBrowser: this.selectedBrowser,
        },
      ];
      return ts;
    },

    get selectedTab() {
      return this.tabs[0];
    },

    set selectedTab(tab) {
      // Synthesize a custom TabSelect event to indicate that a tab has been
      // selected even when we don't change it.
      const event = new window.CustomEvent("TabSelect", {
        bubbles: true,
        cancelable: false,
        detail: {
          previousTab: this.selectedTab,
        },
      });

      window.document.dispatchEvent(event);
    },

    getTabForBrowser() {
      return window;
    },

    get ownerGlobal() {
      return window;
    },

    addEventListener() {
      this.selectedBrowser.addEventListener(...arguments);
    },

    removeEventListener() {
      this.selectedBrowser.removeEventListener(...arguments);
    },
  };

  // Last notification required for marionette to work
  Services.obs.notifyObservers(window, "browser-idle-startup-tasks-finished");
}

function setupContextMenu() {
  const contextMenu = document.getElementById("textbox-contextmenu");
  if (!contextMenu) {
    return;
  }

  // Focus the target on contextmenu so command queries find the right editor.
  window.addEventListener(
    "contextmenu",
    e => {
      let target = e.composedTarget;
      if (target && document.commandDispatcher.focusedElement != target) {
        target.focus();
      }
    },
    true
  );

  function updateMenuItemStates() {
    for (let item of contextMenu.childNodes) {
      let command = item.getAttribute("command");
      if (command) {
        try {
          let controller =
            document.commandDispatcher.getControllerForCommand(command);
          if (controller) {
            let enabled = controller.isCommandEnabled(command);
            if (enabled) {
              item.removeAttribute("disabled");
            } else {
              item.setAttribute("disabled", "true");
            }
          }
        } catch (e) {}
      }
    }
  }

  contextMenu.addEventListener("popupshowing", () => {
    goUpdateGlobalEditMenuItems(true);
    updateMenuItemStates();

    // Command state updates arrive asynchronously for remote content.
    // Listen for updates while the menu is open.
    let updateHandler = () => updateMenuItemStates();
    window.addEventListener("commandupdate", updateHandler);
    contextMenu.addEventListener(
      "popuphidden",
      () => window.removeEventListener("commandupdate", updateHandler),
      { once: true }
    );
  });
}

function setupPopupNotifications() {
  ChromeUtils.defineLazyGetter(window, "PopupNotifications", () => {
    const panel = document.getElementById("notification-popup");
    const anchor = document.getElementById("notification-popup-box");

    panel.addEventListener("popupshowing", () => {
      // Need to shift the anchor element relative to the panel's height and width
      const r = panel.getBoundingClientRect();
      const tx = -(r.width / 2);
      const ty = -(r.height / 2);
      anchor.style.transform = `translate(${tx}px, ${ty}px)`;
    });

    try {
      return new lazy.PopupNotifications(window.gBrowser, panel, anchor, {});
    } catch (ex) {
      console.error(ex);
      return null;
    }
  });
}

window.addEventListener(
  "load",
  () => {
    ErrorReport.init();
    setupMarionetteEnvironment();
    setupPopupNotifications();
    setupContextMenu();
    listenFormEmailSubmission();
    informAboutPotentialStartupFailure();
  },
  true
);
