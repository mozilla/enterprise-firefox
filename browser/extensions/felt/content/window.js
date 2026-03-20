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
  Updates: "resource:///modules/enterprise/Updates.sys.mjs",
});

// Will at least make move forward marionette
Services.obs.notifyObservers(window, "browser-delayed-startup-finished");

const ErrorReport = {
  _wrapper: null,

  init() {
    this._wrapper = document.querySelector(".felt-browser-error");

    this._stringBundles = {};
    ChromeUtils.defineLazyGetter(this._stringBundles, "app", () => {
      return Services.strings.createBundle(
        "chrome://global/locale/appstrings.properties"
      );
    });

    this._wrapper.addEventListener("message-bar:user-dismissed", e => {
      e.preventDefault();
      e.target.classList.add("is-hidden");
    });
  },

  reset() {
    if (!this._wrapper) {
      return;
    }
    if (this._wrapper.classList.contains("is-hidden")) {
      return;
    }
    this._wrapper.classList.add("is-hidden");
    for (const bar of this._wrapper.querySelectorAll("moz-message-bar")) {
      bar.classList.add("is-hidden");
    }
  },

  async update(errorType, details = null, cause = null) {
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
        const message = await this.getLocalisedErrorString(details, cause);
        detailsElement.textContent = message || details;
      }
    }
    errorElement.classList.remove("is-hidden");
    this._wrapper.classList.remove("is-hidden");
  },

  async getLocalisedErrorString(details, cause) {
    const errorMessage = await document.l10n.formatValue(
      `felt-error-${details}`
    );
    if (errorMessage) {
      return errorMessage;
    }
    return this.formatStringBundle(details, cause);
  },

  formatStringBundle(msgId, cause) {
    try {
      return this._stringBundles.app.formatStringFromName(msgId, [cause?.host]);
    } catch (ex) {
      console.error(
        `FELT error localization failed for '${msgId}'. Expected for NSS errors.`
      );
      return null;
    }
  },
};

async function connectToConsole(email) {
  let posture;
  try {
    posture = await lazy.ConsoleClient.sendDevicePosture();
  } catch (err) {
    console.error(`FeltExtension: Failed to connect to console: ${err}`);

    // Show simpler "No Network Connection" only for truly offline scenarios
    // netOffline for offline mode, dnsNotFound2 for actual network disconnect
    const NETWORK_ERRORS = new Set(["netOffline", "dnsNotFound2"]);
    if (NETWORK_ERRORS.has(err.message)) {
      ErrorReport.update(
        "felt-browser-error-no-network",
        "no-network-connection"
      );
    } else {
      ErrorReport.update(
        "felt-browser-error-connection",
        err.message,
        err.cause
      );
    }
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

  // Fallback for token extraction: a cross-process navigation during the SSO
  // redirect chain can cause the FeltWindowChild JSWindowActor's
  // DOMContentLoaded handler to never fire. Monitor the navigation from the
  // parent process and explicitly trigger token extraction when the callback
  // page finishes loading.
  const SSO_TIMEOUT_MS = Services.prefs.getIntPref(
    "enterprise.sso.timeout_ms",
    60000
  );
  const callbackPattern = new MatchPattern(
    lazy.ConsoleClient.ssoCallbackUriMatchPattern
  );

  let ssoCompleted = false;

  function resetToLoginPage(errorType, details = null, cause = null) {
    if (!ssoCompleted) {
      ssoCompleted = true;
      clearTimeout(ssoTimeout);
      try {
        browser.removeProgressListener(progressListener);
      } catch (_) {}
    }
    document.querySelector(".felt-login__sso").classList.add("is-hidden");
    document
      .querySelector(".felt-login__email-pane")
      .classList.remove("is-hidden");
    ErrorReport.update(errorType, details, cause);
  }

  let ssoTimeout = setTimeout(() => {
    console.error("FeltExtension: SSO login timed out");
    resetToLoginPage("felt-browser-error-sso-timeout");
  }, SSO_TIMEOUT_MS);

  const progressListener = {
    QueryInterface: ChromeUtils.generateQI([
      "nsIWebProgressListener",
      "nsISupportsWeakReference",
    ]),

    onStateChange(webProgress, _request, stateFlags, status) {
      if (
        !(stateFlags & Ci.nsIWebProgressListener.STATE_STOP) ||
        !(stateFlags & Ci.nsIWebProgressListener.STATE_IS_NETWORK)
      ) {
        return;
      }

      const uri = webProgress.browsingContext?.currentWindowGlobal?.documentURI;
      if (!uri || !callbackPattern.matches(uri.spec)) {
        return;
      }

      clearTimeout(ssoTimeout);
      browser.removeProgressListener(progressListener);
      ssoCompleted = true;

      if (!Components.isSuccessCode(status)) {
        console.error(
          `FeltExtension: SSO callback page failed to load: 0x${status.toString(16)}`
        );
        resetToLoginPage(
          "felt-browser-error-connection",
          lazy.ConsoleClient._getErrorNameForStatus(status),
          { host: uri.host }
        );
        return;
      }

      const windowGlobal = browser.browsingContext?.currentWindowGlobal;
      if (!windowGlobal) {
        console.error("FeltExtension: No WindowGlobal for SSO callback page");
        resetToLoginPage("felt-browser-error-connection");
        return;
      }

      // getActor() forces actor instantiation, and sendQuery() delivers the
      // message to the child process regardless of whether DOMContentLoaded
      // triggered actor creation.
      try {
        windowGlobal
          .getActor("FeltWindow")
          .sendQuery("ExtractTokens")
          .then(sent => {
            if (!sent) {
              console.error(
                "FeltExtension: Fallback token extraction found no token data"
              );
              resetToLoginPage("felt-browser-error-connection");
            }
          })
          .catch(err => {
            console.error(
              `FeltExtension: Fallback token extraction failed: ${err}`
            );
            resetToLoginPage("felt-browser-error-connection");
          });
      } catch (err) {
        console.error(
          `FeltExtension: Could not reach FeltWindow actor: ${err}`
        );
        resetToLoginPage("felt-browser-error-connection");
      }
    },

    onLocationChange(_webProgress, _request, _location, flags) {
      if (flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_ERROR_PAGE) {
        clearTimeout(ssoTimeout);
        resetToLoginPage("felt-browser-error-connection");
        return;
      }
      // Reset the timeout on each navigation so the limit applies per-page
      // rather than to the entire SSO flow (which may involve slow networks,
      // MFA prompts, etc.).
      clearTimeout(ssoTimeout);
      ssoTimeout = setTimeout(() => {
        console.error("FeltExtension: SSO login timed out");
        resetToLoginPage("felt-browser-error-sso-timeout");
      }, SSO_TIMEOUT_MS);
    },
  };
  browser.addProgressListener(
    progressListener,
    Ci.nsIWebProgress.NOTIFY_STATE_NETWORK | Ci.nsIWebProgress.NOTIFY_LOCATION
  );

  ErrorReport.reset();
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
    lazy.Updates.init(document, ErrorReport);
    setupMarionetteEnvironment();
    setupPopupNotifications();
    setupContextMenu();
    listenFormEmailSubmission();
    informAboutPotentialStartupFailure();
  },
  true
);
