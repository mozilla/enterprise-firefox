/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  AppConstants: "resource://gre/modules/AppConstants.sys.mjs",
  ConsoleClient: "resource://gre/modules/enterprise/ConsoleClient.sys.mjs",
  FeltCommon: "chrome://felt/content/FeltCommon.sys.mjs",
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

/**
 * Pre-authentication captive portal handling (bug 2037079).
 *
 * FELT gates the browser behind enterprise-console sign-in, but a captive portal
 * blocks the console, so the user has to clear the portal first. We surface a
 * banner with a button rather than auto-opening anything: if the OS captive
 * portal assistant already handled it, the user can ignore the banner. Clicking
 * the button reveals an embedded browser (inside this FELT window, not a second
 * top-level window, which would disturb FELT's window-lifecycle bookkeeping) on
 * the portal's sign-in page. That browser is torn down and sign-in resumed based
 * on CaptivePortalService's connectivity signal (captive-portal-login-success),
 * never on the portal's own navigation, so a post-login advertising redirect is
 * irrelevant.
 */
const CaptivePortal = {
  _cps: Cc["@mozilla.org/network/captive-portal-service;1"].getService(
    Ci.nsICaptivePortalService
  ),
  _portalProgressListener: null,

  get canonicalURL() {
    return Services.prefs.getCharPref("captivedetect.canonicalURL");
  },

  get isLocked() {
    return this._cps.state == this._cps.LOCKED_PORTAL;
  },

  init() {
    Services.obs.addObserver(this, "captive-portal-login");
    Services.obs.addObserver(this, "captive-portal-login-success");
    Services.obs.addObserver(this, "captive-portal-login-abort");
    window.addEventListener("unload", () => this.uninit(), { once: true });

    document
      .getElementById("felt-open-network-login")
      .addEventListener("click", () => this.showPortalBrowser());

    if (this.isLocked) {
      this.showBanner();
    } else if (this._cps.state == this._cps.UNKNOWN) {
      // Probe now so the banner can be shown before the user even submits.
      this._cps.recheckCaptivePortal();
    }
  },

  uninit() {
    Services.obs.removeObserver(this, "captive-portal-login");
    Services.obs.removeObserver(this, "captive-portal-login-success");
    Services.obs.removeObserver(this, "captive-portal-login-abort");
  },

  // Re-probe after a failed console request so a portal surfaces as the banner
  // rather than a dead-end connection error.
  recheck() {
    this._cps.recheckCaptivePortal();
  },

  observe(subject, topic) {
    switch (topic) {
      case "captive-portal-login":
        this.showBanner();
        break;
      case "captive-portal-login-success":
        // Connectivity was just restored. While behind the portal, lookups for
        // the console host may have failed or resolved to the portal's
        // interception IP and been cached; the Wi-Fi link never went down, so
        // nothing invalidated them. Flush the DNS cache so console requests
        // resolve freshly instead of failing with a stale entry.
        Services.dns.clearCache(true);
        this.hidePortalBrowser();
        this.hideBanner(true);
        break;
      case "captive-portal-login-abort":
        this.hidePortalBrowser();
        this.hideBanner(false);
        break;
    }
  },

  // Set by connectToConsole() while an SSO attempt is in flight, so a captive
  // portal detected mid-login (e.g. the portal re-locking) can stop tracking
  // that attempt instead of leaving it running behind the banner.
  _ssoAbort: null,

  showBanner() {
    // Detection can follow a failed device-posture/SSO request (see
    // connectToConsole's catch blocks), which shows its own generic
    // connection-error bar before the async recheck confirms a portal. Clear
    // it so it doesn't stack alongside this banner.
    lazy.FeltErrorReport.reset();

    // An in-flight SSO attempt (its browser pane visible) would otherwise sit
    // alongside/underneath the banner instead of being cleanly replaced by it.
    this._ssoAbort?.();
    const ssoBrowser = document.getElementById("browser");
    if (
      !document
        .querySelector(".felt-login__sso")
        .classList.contains("is-hidden")
    ) {
      ssoBrowser.stop();
      document.querySelector(".felt-login__sso").classList.add("is-hidden");
    }

    document
      .querySelector(".felt-login__email-pane")
      .classList.add("is-hidden");
    document
      .querySelector(".felt-browser-error-captive-portal")
      .classList.remove("is-hidden");
  },

  hideBanner(restored) {
    document
      .querySelector(".felt-browser-error-captive-portal")
      .classList.add("is-hidden");
    document
      .querySelector(".felt-login__email-pane")
      .classList.remove("is-hidden");

    // Network is back: resume the sign-in the user had started, if any.
    const email = document.getElementById("felt-form__email").value;
    if (restored && email) {
      connectToConsole(email);
    }
  },

  showPortalBrowser() {
    const url = this.canonicalURL;
    // Keep https-only/https-first from upgrading the plaintext probe URL,
    // mirroring CaptivePortalWatcher._captivePortalDetected. The permission is
    // partitioned by principal origin attributes, and this browser's content
    // is forced to privateBrowsingId=1 because the FELT window itself is
    // opened with the "private" chrome flag (a content BrowsingContext can
    // never have a different privateBrowsingId than its parent chrome
    // window) -- so the principal must match, or the exemption silently
    // won't be found.
    const uri = Services.io.newURI(url);
    const principal = Services.scriptSecurityManager.createContentPrincipal(
      uri,
      { privateBrowsingId: lazy.FeltCommon.PRIVATE_BROWSING_ID }
    );
    Services.perms.addFromPrincipal(
      principal,
      "https-only-load-insecure",
      Ci.nsIPermissionManager.ALLOW_ACTION,
      Ci.nsIPermissionManager.EXPIRE_SESSION
    );

    document.querySelector(".felt-login__portal").classList.remove("is-hidden");

    const browser = document.getElementById("portal-browser");
    browser.setAttribute("maychangeremoteness", "true");
    browser.setAttribute(
      "remoteType",
      ChromeUtils.predictRemoteTypeForURI(url, { browser })
    );
    // Hide the overlay as soon as the portal redirects to the SUMO
    // captive-portal page: once cleared, the canonical content meta-refreshes to
    // support.mozilla.org, which would otherwise flash before the connectivity
    // signal tears the overlay down.
    this._watchForPortalCleared(browser);

    // The portal is untrusted third-party content: load it with a null
    // principal, mirroring CaptivePortalWatcher.ensureCaptivePortalTab.
    browser.fixupAndLoadURIString(url, {
      triggeringPrincipal: Services.scriptSecurityManager.createNullPrincipal(
        {}
      ),
    });
    browser.focus();
  },

  _watchForPortalCleared(browser) {
    this._removePortalProgressListener(browser);
    this._portalProgressListener = {
      QueryInterface: ChromeUtils.generateQI([
        "nsIWebProgressListener",
        "nsISupportsWeakReference",
      ]),
      onLocationChange: (_webProgress, _request, location) => {
        let host = "";
        try {
          host = location?.host;
        } catch (_) {}
        // Only reachable once the portal is cleared; mirrors the
        // support.mozilla.org check in CaptivePortalWatcher.
        if (host === "support.mozilla.org") {
          this.hidePortalBrowser();
        }
      },
    };
    browser.addProgressListener(
      this._portalProgressListener,
      Ci.nsIWebProgress.NOTIFY_LOCATION
    );
  },

  _removePortalProgressListener(browser) {
    if (this._portalProgressListener) {
      try {
        browser.removeProgressListener(this._portalProgressListener);
      } catch (_) {}
      this._portalProgressListener = null;
    }
  },

  hidePortalBrowser() {
    const browser = document.getElementById("portal-browser");
    this._removePortalProgressListener(browser);
    document.querySelector(".felt-login__portal").classList.add("is-hidden");
    // Discard whatever the portal is showing (its login page, a post-login ad
    // redirect, or the canonical/SUMO page). Dismissal is driven by the
    // connectivity signal or the SUMO redirect above, never by arbitrary portal
    // navigation.
    browser.fixupAndLoadURIString("about:blank", {
      triggeringPrincipal: Services.scriptSecurityManager.createNullPrincipal(
        {}
      ),
    });
  },
};

async function connectToConsole(email) {
  let posture;
  // ConsoleClient's underlying XHR has no built-in timeout, so on a captive
  // portal that silently drops packets (rather than actively resetting the
  // connection) this call could hang indefinitely -- and the recovery below
  // (CaptivePortal.recheck()) would never run, since it only fires once this
  // promise rejects. Bound it so a hang surfaces promptly, same as the SSO and
  // update-check timeouts. Aborting (rather than just racing a timeout)
  // cancels the actual in-flight request, so it doesn't keep a connection to
  // the console open in the background -- worth avoiding since a flaky/gated
  // network is exactly where the user is likely to retry more than once.
  const devicePostureTimeoutMs = Services.prefs.getIntPref(
    "enterprise.felt.device_posture_timeout_ms",
    15000
  );
  const devicePostureController = new AbortController();
  const devicePostureTimeout = setTimeout(
    () => devicePostureController.abort(),
    devicePostureTimeoutMs
  );
  try {
    posture = await lazy.ConsoleClient.sendDevicePosture({
      signal: devicePostureController.signal,
    });
  } catch (err) {
    lazy.log.error(`Failed to send device posture: ${err}`);
    // A captive portal (or being offline) surfaces here. Re-probe so that, if it
    // is a portal, the captive-portal-login notification drives the banner
    // instead of a dead-end connection error.
    CaptivePortal.recheck();
    await lazy.FeltErrorReport.handleXhrError(err);
    return;
  } finally {
    clearTimeout(devicePostureTimeout);
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

  // Stops tracking this SSO attempt (timeout + progress listener) without
  // touching the UI. Shared by resetToLoginPage(), the success path below, and
  // CaptivePortal.showBanner() (via _ssoAbort) so a captive portal detected
  // mid-login can interrupt this attempt cleanly.
  function cancelSsoTracking() {
    if (ssoCompleted) {
      return false;
    }
    ssoCompleted = true;
    clearTimeout(ssoTimeout);
    try {
      browser.removeProgressListener(progressListener);
    } catch (_) {}
    CaptivePortal._ssoAbort = null;
    return true;
  }

  function resetToLoginPage(errorType, details = null, cause = null) {
    cancelSsoTracking();
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
    lazy.log.error("SSO login timed out");
    resetToLoginPage("felt-browser-error-sso-timeout");
  }, SSO_TIMEOUT_MS);

  CaptivePortal._ssoAbort = cancelSsoTracking;

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

      cancelSsoTracking();

      if (!Components.isSuccessCode(status)) {
        lazy.log.error(
          `SSO callback page failed to load: 0x${status.toString(16)}`
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
        lazy.log.error("No WindowGlobal for SSO callback page");
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
              lazy.log.error("Fallback token extraction found no token data");
              resetToLoginPage("felt-browser-error-connection");
            }
          })
          .catch(err => {
            lazy.log.error(`Fallback token extraction failed: ${err}`);
            resetToLoginPage("felt-browser-error-connection");
          });
      } catch (err) {
        lazy.log.error(`Could not reach FeltWindow actor: ${err}`);
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
        lazy.log.error("SSO login timed out");
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
    CaptivePortal.init();
    focusEmailOnLoginVisible();
    informAboutPotentialStartupFailure();
    macosActivateApplication();
  },
  true
);
