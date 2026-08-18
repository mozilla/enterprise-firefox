/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  AppConstants: "resource://gre/modules/AppConstants.sys.mjs",
  CaptivePortal: "resource://gre/modules/enterprise/CaptivePortal.sys.mjs",
  ConsoleClient: "resource://gre/modules/enterprise/ConsoleClient.sys.mjs",
  FeltCommon: "chrome://felt/content/FeltCommon.sys.mjs",
  FeltLocking: "chrome://felt/content/FeltLocking.sys.mjs",
  FeltErrorReport: "resource://gre/modules/enterprise/FeltErrorReport.sys.mjs",
  ERROR_SOURCE: "resource://gre/modules/enterprise/FeltErrorReport.sys.mjs",
  FeltStorage: "resource://gre/modules/enterprise/FeltStorage.sys.mjs",
  PopupNotifications: "resource://gre/modules/PopupNotifications.sys.mjs",
  Updates: "resource://gre/modules/enterprise/Updates.sys.mjs",
  createEnterpriseLogger:
    "resource://gre/modules/enterprise/EnterpriseCommon.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  return lazy.createEnterpriseLogger("Felt");
});

// Will at least make move forward marionette
Services.obs.notifyObservers(window, "browser-delayed-startup-finished");

let cancelActiveSso = null;

// Email of a pending sign-in, so onConnectivityRestored resumes the exact
// attempt the user submitted (not the field's current value). Kept across a
// portal interrupt; cleared when the attempt terminally ends.
let pendingSignInEmail = null;

// True while a connectToConsole() attempt is running, to block a concurrent
// second submit/resume. Distinct from pendingSignInEmail, which stays set while
// parked behind a portal with nothing in flight.
let signInInFlight = false;

// Bumped per attempt; an attempt drops its result if its captured value no
// longer matches. Abandons a sign-in left hanging behind a portal (its request
// can't be aborted here) when we retry on portal clear, so its late timeout
// doesn't surface.
let signInGeneration = 0;

const FeltStatusPanel = {
  get _panel() {
    return document.getElementById("felt-statuspanel");
  },
  get _label() {
    return document.getElementById("felt-statuspanel-label");
  },
  update(text) {
    if (text) {
      this._label.textContent = text;
      this._panel.classList.remove("is-hidden");
    } else {
      this._panel.classList.add("is-hidden");
      this._label.textContent = "";
    }
  },
  clear() {
    this.update("");
  },
};

function clearSsoSessionData() {
  return new Promise(resolve => {
    Services.clearData.deleteDataFromOriginAttributesPattern(
      { privateBrowsingId: lazy.FeltCommon.PRIVATE_BROWSING_ID },
      { onDataDeleted: resolve }
    );
  });
}

function resetToLoginPage({ keepPendingSignIn = false } = {}) {
  cancelActiveSso?.();
  // Whatever attempt was running is torn down here; a resume is a fresh call.
  signInInFlight = false;
  // The attempt is over; don't let onConnectivityRestored auto-resume a stale
  // one when a portal clears later. The captive-portal path keeps it set so it
  // can resume the same attempt once the portal clears.
  if (!keepPendingSignIn) {
    pendingSignInEmail = null;
    // The attempt ended for good: run the update check we may have deferred to
    // let it proceed (no-op unless it was suspended and we're connected).
    lazy.CaptivePortal.maybeResumeUpdates();
  }
  FeltStatusPanel.clear();
  document.querySelector(".felt-login__sso").classList.add("is-hidden");
  document
    .querySelector(".felt-login__email-pane")
    .classList.remove("is-hidden");
  document.getElementById("felt-back-button").classList.add("is-hidden");
}

function resetToLoginPageWithError(errorType, details = null, cause = null) {
  resetToLoginPage();
  lazy.FeltErrorReport.update(
    errorType,
    details,
    cause,
    lazy.ERROR_SOURCE.RESET
  );
}

async function connectToConsole(email) {
  // One attempt at a time: block a concurrent second submit or resume.
  if (signInInFlight) {
    return;
  }
  signInInFlight = true;
  const attempt = ++signInGeneration;
  pendingSignInEmail = email;

  // Probe the console for reachability before starting SSO, so an unreachable or
  // misconfigured console address surfaces a clear error here, at the point the
  // user submitted.
  try {
    await lazy.ConsoleClient.probeConsoleReachable();
  } catch (err) {
    if (attempt !== signInGeneration) {
      // Superseded (abandoned on a portal-clear retry); drop silently.
      return;
    }
    lazy.log.error(`Console not reachable: ${err}`);
    signInInFlight = false;
    pendingSignInEmail = null;
    // Re-probe so a real portal surfaces as the captive-portal banner.
    lazy.CaptivePortal.recheck();
    lazy.CaptivePortal.maybeResumeUpdates();
    await lazy.FeltErrorReport.handleXhrError(err);
    return;
  }

  const browser = document.getElementById("browser");

  try {
    // On success tryUnlock has already committed the resumed tokens and started
    // Firefox through the parent actor, so return and skip the SSO flow below.
    if (await lazy.FeltLocking.tryUnlock(email, browser)) {
      return;
    }
  } catch (err) {
    if (attempt !== signInGeneration) {
      // Superseded (abandoned on a portal-clear retry); drop silently.
      return;
    }
    // Surface a failed launch instead of leaving the window stuck in-flight.
    lazy.log.error(`Unlock failed: ${err}`);
    resetToLoginPageWithError("felt-browser-error-connection");
    return;
  }

  const ssoLoginURI = await lazy.ConsoleClient.constructSsoLoginURI(email);

  if (attempt !== signInGeneration) {
    // Superseded (abandoned on a portal-clear retry); drop silently.
    return;
  }

  browser.setAttribute("maychangeremoteness", "true");
  browser.setAttribute(
    "remoteType",
    ChromeUtils.predictRemoteTypeForURI(ssoLoginURI.spec, { browser })
  );
  lazy.log.debug(
    `creating contentPrincipal with privateBrowsingId=${lazy.FeltCommon.PRIVATE_BROWSING_ID}`
  );
  const contentPrincipal =
    Services.scriptSecurityManager.createContentPrincipal(ssoLoginURI, {
      privateBrowsingId: lazy.FeltCommon.PRIVATE_BROWSING_ID,
    });
  lazy.log.debug(
    `created contentPrincipal with privateBrowsingId=${contentPrincipal.privateBrowsingId}`
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

  cancelActiveSso = () => {
    if (!ssoCompleted) {
      ssoCompleted = true;
      clearTimeout(ssoTimeout);
      try {
        browser.removeProgressListener(progressListener);
      } catch (_) {}
    }
    cancelActiveSso = null;
  };

  let ssoTimeout = setTimeout(() => {
    lazy.log.error("SSO login timed out");
    resetToLoginPageWithError("felt-browser-error-sso-timeout");
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

      // Clear status panel. onStatusChange stops firing once the load stops.
      FeltStatusPanel.clear();

      const uri = webProgress.browsingContext?.currentWindowGlobal?.documentURI;
      if (!uri || !callbackPattern.matches(uri.spec)) {
        return;
      }

      cancelActiveSso?.();

      if (!Components.isSuccessCode(status)) {
        lazy.log.error(
          `SSO callback page failed to load: 0x${status.toString(16)}`
        );
        resetToLoginPageWithError(
          "felt-browser-error-connection",
          lazy.FeltErrorReport.getFluentIdForStatus(status),
          { hostname: uri.host }
        );
        return;
      }

      const windowGlobal = browser.browsingContext?.currentWindowGlobal;
      if (!windowGlobal) {
        lazy.log.error("No WindowGlobal for SSO callback page");
        resetToLoginPageWithError("felt-browser-error-connection");
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
              lazy.log.error("Fallback token extraction found no token data");
              resetToLoginPageWithError("felt-browser-error-connection");
            }
          })
          .catch(err => {
            lazy.log.error(`Fallback token extraction failed: ${err}`);
            resetToLoginPageWithError("felt-browser-error-connection");
          });
      } catch (err) {
        lazy.log.error(`Could not reach FeltWindow actor: ${err}`);
        resetToLoginPageWithError("felt-browser-error-connection");
      }
    },

    onStatusChange(_webProgress, _request, _status, message) {
      if (browser.webProgress.isLoadingDocument) {
        FeltStatusPanel.update(message);
      } else {
        FeltStatusPanel.clear();
      }
    },

    onLocationChange(_webProgress, _request, _location, flags) {
      if (flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_ERROR_PAGE) {
        clearTimeout(ssoTimeout);
        resetToLoginPageWithError("felt-browser-error-connection");
        return;
      }
      // Reset the timeout on each navigation so the limit applies per-page
      // rather than to the entire SSO flow (which may involve slow networks,
      // MFA prompts, etc.).
      clearTimeout(ssoTimeout);
      ssoTimeout = setTimeout(() => {
        lazy.log.error("SSO login timed out");
        resetToLoginPageWithError("felt-browser-error-sso-timeout");
      }, SSO_TIMEOUT_MS);
    },
  };
  browser.addProgressListener(
    progressListener,
    Ci.nsIWebProgress.NOTIFY_STATE_NETWORK |
      Ci.nsIWebProgress.NOTIFY_LOCATION |
      Ci.nsIWebProgress.NOTIFY_STATUS
  );

  lazy.FeltErrorReport.reset();
  document.querySelector(".felt-updates-message").classList.add("is-hidden");
  document.querySelector(".felt-login__email-pane").classList.add("is-hidden");
  document.querySelector(".felt-login__sso").classList.remove("is-hidden");
  document.getElementById("felt-back-button").classList.remove("is-hidden");

  const ssoBrowsingContext = document.getElementById("browser");
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

  window.FeltStatusPanel = FeltStatusPanel;

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

  // Last notification required for marionette to work.
  const observer = {
    observe(_aSubject, _aTopic) {
      Services.obs.removeObserver(observer, "final-ui-startup");
      Services.tm.dispatchToMainThread(() =>
        Services.obs.notifyObservers(
          window,
          "browser-idle-startup-tasks-finished"
        )
      );
    },
  };
  if (Services.startup.startingUp) {
    Services.obs.addObserver(observer, "final-ui-startup");
  } else {
    Services.obs.notifyObservers(window, "browser-idle-startup-tasks-finished");
  }
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
      document.body.classList.add("notification-open");
    });

    panel.addEventListener("popuphidden", () => {
      document.body.classList.remove("notification-open");
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
  const emailPane = document.querySelector(".felt-login__email-pane");
  const portalPane = document.querySelector(".felt-login__portal");
  const emailInput = document.getElementById("felt-form__email");

  // Focus the email field only when it's the uncovered active surface, not when
  // the SSO or captive-portal browser is up over the login area.
  function maybeFocusEmail() {
    const loginVisible = !loginPane.classList.contains("is-hidden");
    const emailVisible = !emailPane.classList.contains("is-hidden");
    const portalShown = !portalPane.classList.contains("is-hidden");
    if (loginVisible && emailVisible && !portalShown) {
      emailInput?.focus();
    }
  }

  // subtree: react to the email/sso/portal panes toggling, not just .felt-login.
  new MutationObserver(maybeFocusEmail).observe(loginPane, {
    attributeFilter: ["class"],
    subtree: true,
  });

  // Refocus on activation, for when login appears while the window is backgrounded.
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

function setupBackButton() {
  const backButton = document.getElementById("felt-back-button");
  backButton.addEventListener("click", async () => {
    resetToLoginPage();
    await clearSsoSessionData();
    document.getElementById("browser").fixupAndLoadURIString("about:blank", {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
  });
}

window.addEventListener(
  "load",
  () => {
    setBuildVersion();
    lazy.FeltErrorReport.init(document);
    setupMarionetteEnvironment();
    setupPopupNotifications();
    setupContextMenu();
    setupBackButton();
    listenFormEmailSubmission();
    focusEmailOnLoginVisible();
    informAboutPotentialStartupFailure();
    macosActivateApplication();

    // Start the update check immediately so the login pane is hidden before it
    // paints (no flash). If a captive portal turns up, CaptivePortal suspends
    // the check and shows the banner, then resumes it once connectivity is back.
    lazy.Updates.init(document);
    lazy.CaptivePortal.init(document, {
      // Flip the UI back to the login form when a portal interrupts SSO, keeping
      // the pending attempt so it resumes once the portal clears.
      resetLoginUi: () => resetToLoginPage({ keepPendingSignIn: true }),
      onConnectivityRestored: () => {
        // Resume the submitted attempt. Freeing the guard lets the retry bump the
        // generation, abandoning a sign-in left hanging behind the portal so its
        // stale timeout is dropped rather than shown.
        if (pendingSignInEmail) {
          signInInFlight = false;
          connectToConsole(pendingSignInEmail);
        }
      },
      suspendUpdates: () => lazy.Updates.suspend(),
      resumeUpdates: () => {
        // Defer to a resuming sign-in (it takes the window). Returning false keeps
        // the check suspended so it's retried when the sign-in ends.
        if (pendingSignInEmail) {
          return false;
        }
        lazy.Updates.init(document);
        return true;
      },
    });
  },
  true
);
