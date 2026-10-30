/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  IPPProxyManager:
    "moz-src:///toolkit/components/ipprotection/IPPProxyManager.sys.mjs",
  IPPProxyStates:
    "moz-src:///toolkit/components/ipprotection/IPPProxyManager.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "logConsole", () =>
  console.createInstance({
    prefix: "IPP_ConnectionMonitor",
    maxLogLevel: Services.prefs.getBoolPref("browser.ipProtection.log", false)
      ? "Debug"
      : "Warn",
  })
);

const STOP_REQUEST_TOPIC = "http-on-stop-request";

/**
 * Records an Access Connector security event the first time a top-level page
 * on a domain loads through the proxy without a network or proxy error. Each
 * time the proxy becomes active again, domains are reported anew.
 */
class IPPConnectionMonitorSingleton {
  #initialized = false;
  #observing = false;
  /** @type {Set<string>} Domains reported since the proxy became active. */
  #accessedDomains = new Set();
  /** @type {Set<string>} Isolation keys used since the proxy became active. */
  #isolationKeys = new Set();

  constructor() {
    this.handleProxyEvent = this.#onProxyStateChanged.bind(this);
    this.handleIsolationKeyEvent = this.#onIsolationKeyAdded.bind(this);
  }

  init() {
    if (this.#initialized) {
      return;
    }
    this.#initialized = true;
    lazy.IPPProxyManager.addEventListener(
      "IPPProxyManager:StateChanged",
      this.handleProxyEvent
    );
    lazy.IPPProxyManager.addEventListener(
      "IPPProxyManager:IsolationKeyAdded",
      this.handleIsolationKeyEvent
    );
    this.#updateObserving();
  }

  initOnStartupCompleted() {}

  uninit() {
    if (!this.#initialized) {
      return;
    }
    this.#initialized = false;
    lazy.IPPProxyManager.removeEventListener(
      "IPPProxyManager:StateChanged",
      this.handleProxyEvent
    );
    lazy.IPPProxyManager.removeEventListener(
      "IPPProxyManager:IsolationKeyAdded",
      this.handleIsolationKeyEvent
    );
    this.#setObserving(false);
    this.#accessedDomains.clear();
    this.#isolationKeys.clear();
  }

  #onProxyStateChanged() {
    if (lazy.IPPProxyManager.state !== lazy.IPPProxyStates.ACTIVE) {
      this.#accessedDomains.clear();
      this.#isolationKeys.clear();
    }
    this.#updateObserving();
  }

  #onIsolationKeyAdded({ detail: { isolationKey } }) {
    if (lazy.IPPProxyManager.active && isolationKey) {
      this.#isolationKeys.add(isolationKey);
    }
  }

  /**
   * Observes requests only while the proxy connection exists.
   */
  #updateObserving() {
    this.#setObserving(this.#initialized && !!lazy.IPPProxyManager.active);
    if (
      this.#observing &&
      lazy.IPPProxyManager.state === lazy.IPPProxyStates.ACTIVE &&
      lazy.IPPProxyManager.isolationKey
    ) {
      this.#isolationKeys.add(lazy.IPPProxyManager.isolationKey);
    }
  }

  /**
   * @param {boolean} observing
   */
  #setObserving(observing) {
    if (observing === this.#observing) {
      return;
    }
    this.#observing = observing;
    if (observing) {
      Services.obs.addObserver(this, STOP_REQUEST_TOPIC);
    } else {
      Services.obs.removeObserver(this, STOP_REQUEST_TOPIC);
    }
  }

  /**
   * @param {nsISupports} subject - The finished channel.
   * @param {string} _topic
   */
  observe(subject, _topic) {
    let channel;
    try {
      channel = subject.QueryInterface(Ci.nsIHttpChannel);
    } catch {
      return;
    }
    if (
      channel.loadInfo?.externalContentPolicyType !==
      Ci.nsIContentPolicy.TYPE_DOCUMENT
    ) {
      return;
    }
    if (!this.#hasTrackedIsolationKey(channel)) {
      return;
    }

    let domain;
    try {
      domain = channel.URI.host;
    } catch {
      return;
    }
    if (!domain) {
      return;
    }

    if (
      Components.isSuccessCode(channel.status) &&
      !this.#accessedDomains.has(domain)
    ) {
      this.#accessedDomains.add(domain);
      this.#record(Glean.accessConnector.domainAccessed, domain);
    }
  }

  /**
   * Returns true if the channel was routed through the Access Connector since
   * it last became active. Keys replaced by rotation or a server switch are
   * still tracked, so loads that started before the change are counted.
   *
   * @param {nsIHttpChannel} channel
   * @returns {boolean}
   */
  #hasTrackedIsolationKey(channel) {
    try {
      const { proxyInfo } = channel.QueryInterface(Ci.nsIProxiedChannel);
      return this.#isolationKeys.has(proxyInfo?.connectionIsolationKey);
    } catch {
      return false;
    }
  }

  /**
   * Records an Access Connector event and submits the enterprise ping.
   *
   * @param {object} metric - The Glean event metric to record.
   * @param {string} domain - The host of the top-level page.
   */
  #record(metric, domain) {
    try {
      metric.record({ domain });
      GleanPings.enterprise.submit();
    } catch (e) {
      lazy.logConsole.error("Failed to record Access Connector event:", e);
    }
  }
}

IPPConnectionMonitorSingleton.prototype.QueryInterface = ChromeUtils.generateQI(
  [Ci.nsIObserver]
);

const IPPConnectionMonitor = new IPPConnectionMonitorSingleton();

export { IPPConnectionMonitor, IPPConnectionMonitorSingleton };
