/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  createEnterpriseLogger:
    "moz-src:///toolkit/components/enterprise/modules/EnterpriseCommon.sys.mjs",
  IPPProxyManager:
    "moz-src:///toolkit/components/ipprotection/IPPProxyManager.sys.mjs",
  IPPProxyStates:
    "moz-src:///toolkit/components/ipprotection/IPPProxyManager.sys.mjs",
  IPPPrincipalRules:
    "moz-src:///toolkit/components/ipprotection/IPPSiteRuleManager.sys.mjs",
  IPPSiteRuleManager:
    "moz-src:///toolkit/components/ipprotection/IPPSiteRuleManager.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "logConsole", () =>
  lazy.createEnterpriseLogger("IPPEnterpriseTelemetry")
);

const STOP_REQUEST_TOPIC = "http-on-stop-request";
// Rotations and server switches keep adding keys while the proxy is up. Only
// loads already in flight when the key changed need an old key, and those
// finish long before ten more rotations.
const MAX_TRACKED_ISOLATION_KEYS = 10;
const PROXY_HTTP_ERROR_MIN = Cr.NS_ERROR_PROXY_CODE_BASE + 300;
const PROXY_HTTP_ERROR_MAX = Cr.NS_ERROR_PROXY_CODE_BASE + 599;

/**
 * Returns true if a finished channel failed because of the proxy rather than
 * the site.
 *
 * @param {nsIHttpChannel} channel
 * @returns {boolean}
 */
function isProxyFailure(channel) {
  const { status } = channel;
  if (
    status === Cr.NS_ERROR_PROXY_CONNECTION_REFUSED ||
    status === Cr.NS_ERROR_UNKNOWN_PROXY_HOST ||
    (status >= PROXY_HTTP_ERROR_MIN && status <= PROXY_HTTP_ERROR_MAX)
  ) {
    return true;
  }
  // -1 means the load didn't tunnel and 0 that the tunnel never answered.
  const { httpProxyConnectResponseCode } = channel.QueryInterface(
    Ci.nsIProxiedChannel
  );
  return httpProxyConnectResponseCode >= 300;
}

/**
 * Returns true if the page came from the cache without reaching the network.
 * isFromCache() is unavailable once the channel has stopped.
 *
 * @param {nsIHttpChannel} channel
 * @returns {boolean}
 */
function isCacheHit(channel) {
  try {
    return (
      channel.QueryInterface(Ci.nsICacheInfoChannel).getCacheDisposition() ===
      Ci.nsICacheInfoChannel.kCacheHit
    );
  } catch {
    return false;
  }
}

/**
 * Records Access Connector security events for top-level page loads routed
 * through the proxy: the first time a domain loads without a network or proxy
 * error, and the first time a domain fails to load because of the proxy.
 * Successful loads are reported anew each time the proxy becomes active again,
 * and failures once until the domain loads through the proxy again.
 */
class IPPEnterpriseTelemetrySingleton {
  #initialized = false;
  #observing = false;
  /**
   * True from the proxy entering the error state until it is active again.
   * The failed connection's loads keep finishing after it is torn down.
   */
  #connectionFailed = false;
  /** @type {Set<string>} Domains reported since the proxy became active. */
  #accessedDomains = new Set();
  /** @type {Set<string>} Domains reported as failing that haven't loaded since. */
  #errorDomains = new Set();
  /** @type {Set<string>} Isolation keys used by the current connection. */
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
    this.#connectionFailed = false;
    this.#accessedDomains.clear();
    this.#errorDomains.clear();
    this.#isolationKeys.clear();
  }

  /**
   * IPPAlwaysOn stops the proxy while the ERROR notification is still being
   * dispatched, so this can receive READY before ERROR, and the manager's
   * state already reads READY for both. The event's own states are used
   * instead.
   *
   * @param {CustomEvent} event
   */
  #onProxyStateChanged({ detail: { state, prevState } }) {
    if (state === lazy.IPPProxyStates.ACTIVE) {
      // Reaching ACTIVE doesn't show that the proxy works, so failing domains
      // stay reported until they load.
      if (this.#connectionFailed) {
        this.#connectionFailed = false;
        this.#isolationKeys.clear();
      }
    } else {
      this.#accessedDomains.clear();
      if (
        state === lazy.IPPProxyStates.ERROR ||
        prevState === lazy.IPPProxyStates.ERROR
      ) {
        this.#connectionFailed = true;
      } else if (!this.#connectionFailed) {
        this.#errorDomains.clear();
        this.#isolationKeys.clear();
      }
    }
    this.#updateObserving();
  }

  #onIsolationKeyAdded({ detail: { isolationKey } }) {
    if (lazy.IPPProxyManager.active && isolationKey) {
      this.#isolationKeys.add(isolationKey);
      if (this.#isolationKeys.size > MAX_TRACKED_ISOLATION_KEYS) {
        this.#isolationKeys.delete(this.#isolationKeys.values().next().value);
      }
    }
  }

  /**
   * Observes requests while the proxy connection exists, and after it fails
   * until it is active again.
   */
  #updateObserving() {
    this.#setObserving(
      this.#initialized &&
        (!!lazy.IPPProxyManager.active || this.#connectionFailed)
    );
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
      // Channels served by a service worker aren't proxied channels.
      channel.QueryInterface(Ci.nsIProxiedChannel);
    } catch {
      return;
    }
    if (
      channel.loadInfo?.externalContentPolicyType !==
      Ci.nsIContentPolicy.TYPE_DOCUMENT
    ) {
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

    if (isProxyFailure(channel)) {
      if (
        !this.#errorDomains.has(domain) &&
        this.#isAccessConnectorFailure(channel)
      ) {
        this.#errorDomains.add(domain);
        this.#record(Glean.accessConnector.proxyError, domain);
      }
      return;
    }

    if (
      lazy.IPPProxyManager.state !== lazy.IPPProxyStates.ACTIVE ||
      !Components.isSuccessCode(channel.status) ||
      !this.#hasTrackedIsolationKey(channel)
    ) {
      return;
    }

    // Matches how IPPNetworkErrorObserver detects a rejected tunnel.
    const { httpProxyConnectResponseCode } = channel.QueryInterface(
      Ci.nsIProxiedChannel
    );
    if (![0, 200].includes(httpProxyConnectResponseCode)) {
      return;
    }

    // A page from the cache doesn't show that the proxy works again.
    if (!isCacheHit(channel)) {
      this.#errorDomains.delete(domain);
    }
    if (this.#accessedDomains.has(domain)) {
      return;
    }

    this.#accessedDomains.add(domain);
    this.#record(Glean.accessConnector.domainAccessStarted, domain);
  }

  /**
   * Returns true if a channel that failed because of a proxy was routed
   * through the Access Connector.
   *
   * @param {nsIHttpChannel} channel
   * @returns {boolean}
   */
  #isAccessConnectorFailure(channel) {
    if (this.#hasTrackedIsolationKey(channel)) {
      return true;
    }

    // When the connection fails, IPPChannelFilter cancels the loads it would
    // proxy before they reach a proxy, so they carry no isolation key.
    if (
      !this.#connectionFailed ||
      channel.status !== Cr.NS_ERROR_PROXY_CONNECTION_REFUSED ||
      channel.QueryInterface(Ci.nsIProxiedChannel).proxyInfo
    ) {
      return false;
    }
    const { targetBrowsingContext, browsingContext } = channel.loadInfo;
    const rule = lazy.IPPSiteRuleManager.getRule(
      Services.scriptSecurityManager.getChannelURIPrincipal(channel),
      (targetBrowsingContext ?? browsingContext)?.top.browserId
    );
    return rule === lazy.IPPPrincipalRules.INCLUDED;
  }

  /**
   * Returns true if the channel was routed through the Access Connector since
   * it last became active. The most recent keys replaced by rotation or a
   * server switch are still tracked, so loads that started before the change
   * are counted.
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

IPPEnterpriseTelemetrySingleton.prototype.QueryInterface =
  ChromeUtils.generateQI([Ci.nsIObserver]);

const IPPEnterpriseTelemetry = new IPPEnterpriseTelemetrySingleton();

export { IPPEnterpriseTelemetry, IPPEnterpriseTelemetrySingleton };
