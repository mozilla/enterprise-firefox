/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  AppConstants: "resource://gre/modules/AppConstants.sys.mjs",
  ConsoleClient: "resource:///modules/enterprise/ConsoleClient.sys.mjs",
  FeltCommon: "chrome://felt/content/FeltCommon.sys.mjs",
  FeltErrorReport: "resource:///modules/FeltErrorReport.sys.mjs",
  ERROR_SOURCE: "resource:///modules/FeltErrorReport.sys.mjs",
  FeltStorage: "resource:///modules/FeltStorage.sys.mjs",
  PopupNotifications: "resource://gre/modules/PopupNotifications.sys.mjs",
  Updates: "resource:///modules/enterprise/Updates.sys.mjs",
  createEnterpriseLogger:
    "resource:///modules/enterprise/EnterpriseCommon.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  return lazy.createEnterpriseLogger("Felt");
});

// Will at least make move forward marionette
Services.obs.notifyObservers(window, "browser-delayed-startup-finished");

async function connectToConsole(email) {
  let posture;
  try {
    posture = await lazy.ConsoleClient.sendDevicePosture();
  } catch (err) {
    lazy.log.error(`Failed to send device posture: ${err}`);
    await lazy.FeltErrorReport.handleXhrError(err);
    return;
  }

  if (!posture) {
    // TODO: Currently we don't check the posture yet. In the future we need to handle rejected device posture
    return;
  }

  const ssoLoginURI = await lazy.ConsoleClient.constructSsoLoginURI(
    email,
    posture.posture
  );

  const browser = document.getElementById("browser");
  browser.setAttribute("maychangeremoteness", "true");
  browser.setAttribute(
    "remoteType",
    ChromeUtils.predictRemoteTypeForURI(ssoLoginURI.spec, { browser })
  );
  lazy.log.debug(
    `FeltExtension: creating contentPrincipal with privateBrowsingId=${lazy.FeltCommon.PRIVATE_BROWSING_ID}`
  );
  const contentPrincipal =
    Services.scriptSecurityManager.createContentPrincipal(ssoLoginURI, {
      privateBrowsingId: lazy.FeltCommon.PRIVATE_BROWSING_ID,
    });
  lazy.log.debug(
    `FeltExtension: created contentPrincipal with privateBrowsingId=${contentPrincipal.privateBrowsingId}`
  );
  lazy.log.debug("Load SSO URI: ", ssoLoginURI.spec);
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
    await lazy.ConsoleClient.ssoCallbackUriMatchPattern
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
    lazy.FeltErrorReport.update(
      errorType,
      details,
      cause,
      lazy.ERROR_SOURCE.RESET
    );
  }

  let ssoTimeout = setTimeout(() => {
    lazy.log.error("FeltExtension: SSO login timed out");
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
        lazy.log.error(
          `FeltExtension: SSO callback page failed to load: 0x${status.toString(16)}`
        );
        resetToLoginPage(
          "felt-browser-error-connection",
          lazy.FeltErrorReport.getFluentIdForStatus(status),
          { hostname: uri.host }
        );
        return;
      }

      const windowGlobal = browser.browsingContext?.currentWindowGlobal;
      if (!windowGlobal) {
        lazy.log.error("FeltExtension: No WindowGlobal for SSO callback page");
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
              lazy.log.error(
                "FeltExtension: Fallback token extraction found no token data"
              );
              resetToLoginPage("felt-browser-error-connection");
            }
          })
          .catch(err => {
            lazy.log.error(
              `FeltExtension: Fallback token extraction failed: ${err}`
            );
            resetToLoginPage("felt-browser-error-connection");
          });
      } catch (err) {
        lazy.log.error(
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
        lazy.log.error("FeltExtension: SSO login timed out");
        resetToLoginPage("felt-browser-error-sso-timeout");
      }, SSO_TIMEOUT_MS);
    },
  };
  browser.addProgressListener(
    progressListener,
    Ci.nsIWebProgress.NOTIFY_STATE_NETWORK | Ci.nsIWebProgress.NOTIFY_LOCATION
  );

  lazy.FeltErrorReport.reset();
  document.querySelector(".felt-updates-message").classList.add("is-hidden");
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
      lazy.FeltErrorReport.update(errorClass);
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

    get documentGlobal() {
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
      lazy.log.error(ex);
      return null;
    }
  });
}

// Focus the email input whenever the login pane becomes visible. A
// MutationObserver is used because Updates.init() may hide the login pane
// during its update check and only show it again once the check completes,
// so a direct focus() call at startup would fire while the pane is hidden.
function focusEmailOnLoginVisible() {
  const loginPane = document.querySelector(".felt-login");
  const emailInput = document.getElementById("felt-form__email");

  function maybeFocusEmail() {
    if (!loginPane.classList.contains("is-hidden")) {
      emailInput?.focus();
    }
  }

  new MutationObserver(maybeFocusEmail).observe(loginPane, {
    attributeFilter: ["class"],
  });

  window.addEventListener("focus", maybeFocusEmail);

  maybeFocusEmail();
}

/**
 * Sets the displayed Firefox build version and date
 */
function setBuildVersion() {
  const versionElement = document.querySelector(".felt-version");
  const version = lazy.AppConstants.MOZ_APP_VERSION_DISPLAY;

  if (lazy.AppConstants.NIGHTLY_BUILD) {
    const buildID = Services.appinfo.appBuildID;
    const year = buildID.slice(0, 4);
    const month = buildID.slice(4, 6);
    const day = buildID.slice(6, 8);
    const isodate = `${year}-${month}-${day}`;
    versionElement.setAttribute("data-l10n-id", "felt-version-nightly");
    document.l10n.setArgs(versionElement, { version, isodate });
  } else {
    versionElement.setAttribute("data-l10n-id", "felt-version");
    document.l10n.setArgs(versionElement, { version });
  }
}

// bug 2006564
// make sure that when application starts from dock it enforces windows' focus via activateApplication
// https://searchfox.org/enterprise-main/rev/4b4e7c59db50500302fa0e437ee07a84d92aa076/widget/nsIMacDockSupport.idl#36-45
function macosActivateApplication() {
  if (lazy.AppConstants.platform === "macosx") {
    Cc["@mozilla.org/widget/macdocksupport;1"]
      .getService(Ci.nsIMacDockSupport)
      .activateApplication(true);
  }
}

window.addEventListener(
  "load",
  () => {
    setBuildVersion();
    lazy.FeltErrorReport.init(document);
    lazy.Updates.init(document);
    setupMarionetteEnvironment();
    setupPopupNotifications();
    setupContextMenu();
    listenFormEmailSubmission();
    focusEmailOnLoginVisible();
    informAboutPotentialStartupFailure();
    macosActivateApplication();
  },
  true
);
