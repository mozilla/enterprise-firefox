/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  FeltCommon: "chrome://felt/content/FeltCommon.sys.mjs",
  FeltErrorReport: "moz-src:///toolkit/components/felt/FeltErrorReport.sys.mjs",
});

/**
 * Pre-authentication captive-portal sign-in for FELT. Shows a
 * banner rather than auto-opening anything, and hosts the portal in an
 * embedded browser rather than a second top-level window (which would disturb
 * FELT's window-lifecycle bookkeeping). Dismissal follows CaptivePortalService's
 * connectivity signal, not the portal's navigation.
 *
 * Owns the captive-portal parts of the FELT login DOM (the banner and the
 * portal browser) and drives them by selector off the document passed to
 * init(). It does not touch the sign-in flow itself: the FELT window injects
 * callbacks (resetLoginUi, onConnectivityRestored, suspend/resumeUpdates) so
 * this module never calls into window.js's sign-in logic directly.
 */
export const CaptivePortal = {
  _cps: Cc["@mozilla.org/network/captive-portal-service;1"].getService(
    Ci.nsICaptivePortalService
  ),

  // Document of the FELT window, provided at init().
  _doc: null,

  // Injected by init():
  //   onConnectivityRestored() - network is back; FELT may resume sign-in.
  //   resetLoginUi()          - flip the UI back to the login form (aborting any
  //                             in-flight SSO), keeping a pending sign-in.
  //   suspendUpdates()        - stop the startup update check behind a portal.
  //   resumeUpdates()         - re-run the update check once connectivity is back.
  _onConnectivityRestored: null,
  _resetLoginUi: null,
  _suspendUpdates: null,
  _resumeUpdates: null,

  // True while we've suspended the update check for a portal, so we only resume
  // a check we actually stopped (and never disturb an in-progress one).
  _updatesSuspended: false,

  get canonicalURL() {
    return Services.prefs.getCharPref("captivedetect.canonicalURL");
  },

  /**
   * @param {Document} doc - The FELT window document.
   * @param {object} [hooks]
   * @param {Function} [hooks.onConnectivityRestored]
   * @param {Function} [hooks.resetLoginUi]
   * @param {Function} [hooks.suspendUpdates]
   * @param {Function} [hooks.resumeUpdates]
   */
  init(
    doc,
    { onConnectivityRestored, resetLoginUi, suspendUpdates, resumeUpdates } = {}
  ) {
    this._doc = doc;
    this._onConnectivityRestored = onConnectivityRestored;
    this._resetLoginUi = resetLoginUi;
    this._suspendUpdates = suspendUpdates;
    this._resumeUpdates = resumeUpdates;

    Services.obs.addObserver(this, "captive-portal-login");
    Services.obs.addObserver(this, "captive-portal-login-success");
    Services.obs.addObserver(this, "captive-portal-login-abort");
    Services.obs.addObserver(this, "network:captive-portal-connectivity");
    this._doc.defaultView.addEventListener("unload", () => this.uninit(), {
      once: true,
    });

    this._doc
      .getElementById("felt-open-network-login")
      .addEventListener("click", () => this.showPortalBrowser());

    // Already behind a portal at startup: stop the update check and surface the
    // banner. Otherwise let the update check (already running) proceed; if a
    // portal turns up mid-check our observer interrupts it.
    if (this._cps.state == this._cps.LOCKED_PORTAL) {
      this.showBanner();
    } else if (this._cps.state == this._cps.UNKNOWN) {
      // Probe so a portal surfaces promptly rather than as an update failure.
      this._cps.recheckCaptivePortal();
    }
  },

  // Track that we suspended, so we only ever resume a check we stopped.
  _suspendUpdatesForPortal() {
    if (!this._updatesSuspended) {
      this._updatesSuspended = true;
      this._suspendUpdates?.();
    }
  },

  // Resume the suspended check once connectivity is confirmed and no sign-in is
  // holding it off. Only clears the flag if the check actually ran, so a resume
  // declined for a pending sign-in is retried when that sign-in ends rather than
  // lost. _cps.state is safe to read here (not the login observer's racy path).
  maybeResumeUpdates() {
    const state = this._cps.state;
    const connected =
      state == this._cps.NOT_CAPTIVE || state == this._cps.UNLOCKED_PORTAL;
    if (this._updatesSuspended && connected && this._resumeUpdates?.()) {
      this._updatesSuspended = false;
    }
  },

  uninit() {
    Services.obs.removeObserver(this, "captive-portal-login");
    Services.obs.removeObserver(this, "captive-portal-login-success");
    Services.obs.removeObserver(this, "captive-portal-login-abort");
    Services.obs.removeObserver(this, "network:captive-portal-connectivity");
    this._onConnectivityRestored = null;
    this._resetLoginUi = null;
    this._suspendUpdates = null;
    this._resumeUpdates = null;
    this._doc = null;
  },

  // Re-probe so a real portal surfaces as the banner, not a dead-end error.
  recheck() {
    this._cps.recheckCaptivePortal();
  },

  observe(subject, topic) {
    switch (topic) {
      case "captive-portal-login":
        this.showBanner();
        break;
      case "captive-portal-login-success":
        // DNS lookups made while captive may be cached stale; flush so console
        // requests resolve freshly now that we're connected.
        Services.dns.clearCache(true);
        this.hidePortalBrowser();
        this.hideBanner(true);
        this.maybeResumeUpdates();
        break;
      case "captive-portal-login-abort":
        // Keep updates suspended until connectivity is confirmed. Abort from
        // CaptivePortalService::Stop() self-heals: its Start() re-probe fires
        // network:captive-portal-connectivity, which resumes us.
        this.hidePortalBrowser();
        this.hideBanner(false);
        break;
      case "network:captive-portal-connectivity":
        this.maybeResumeUpdates();
        break;
    }
  },

  showBanner() {
    // Suspend the update check so it doesn't error behind the portal; this also
    // restores the login pane for the banner to sit on.
    this._suspendUpdatesForPortal();

    // Clear any stray connection-error bar from a failed posture/SSO attempt.
    lazy.FeltErrorReport.reset();

    // Stop any in-flight SSO load and flip back to the login form. resetLoginUi()
    // is the shared reset (also clears the back button/status panel) and keeps
    // the pending sign-in so it resumes once the portal clears.
    this._doc.getElementById("browser").stop();
    this._resetLoginUi?.();

    this._doc
      .querySelector(".felt-browser-error-captive-portal")
      .classList.remove("is-hidden");
  },

  hideBanner(restored) {
    this._doc
      .querySelector(".felt-browser-error-captive-portal")
      .classList.add("is-hidden");

    // Network is back: let the FELT window decide whether to resume a sign-in.
    if (restored) {
      this._onConnectivityRestored?.();
    }
  },

  showPortalBrowser() {
    const url = this.canonicalURL;
    // Exempt the plaintext probe from HTTPS upgrade. HTTPS-First is on by default
    // in private browsing and this browser is private, so the http probe would be
    // upgraded and a portal couldn't intercept it. pbId must be 1 to match. Same
    // as desktop's browser-captivePortal.js.
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

    // Hide the banner: it sits outside .felt-login, so the portal overlay
    // won't cover it.
    this._doc
      .querySelector(".felt-browser-error-captive-portal")
      .classList.add("is-hidden");

    this._doc
      .querySelector(".felt-login__portal")
      .classList.remove("is-hidden");

    const browser = this._doc.getElementById("portal-browser");
    // Browser starts in-process (no remote="true" in markup, saving a startup
    // content process); DocumentLoadListener switches it to a content process
    // from the URL (gated on the markup's maychangeremoteness), so untrusted
    // portal content stays isolated.

    // Untrusted third-party content: null principal carrying the private
    // browsing id so its origin attributes match the docshell.
    browser.fixupAndLoadURIString(url, {
      triggeringPrincipal: Services.scriptSecurityManager.createNullPrincipal({
        privateBrowsingId: lazy.FeltCommon.PRIVATE_BROWSING_ID,
      }),
    });
    browser.focus();
  },

  hideOverlay() {
    this._doc.querySelector(".felt-login__portal").classList.add("is-hidden");
  },

  hidePortalBrowser() {
    const browser = this._doc.getElementById("portal-browser");
    this.hideOverlay();
    // The portal shares the private session (pbId=1) with SSO, and FELT collects
    // every cookie in it, so drop the portal's cookies on teardown. Clearing the
    // whole jar is safe: an SSO the portal interrupted was aborted and restarts
    // clean, so there are no console cookies to lose.
    Services.cookies.removeCookiesWithOriginAttributes(
      JSON.stringify({ privateBrowsingId: lazy.FeltCommon.PRIVATE_BROWSING_ID })
    );
    // Discard the portal page; dismissal follows the connectivity signal.
    browser.fixupAndLoadURIString("about:blank", {
      triggeringPrincipal: Services.scriptSecurityManager.createNullPrincipal({
        privateBrowsingId: lazy.FeltCommon.PRIVATE_BROWSING_ID,
      }),
    });
  },
};
