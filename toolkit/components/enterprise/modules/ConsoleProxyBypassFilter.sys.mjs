/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const lazy = XPCOMUtils.declareLazy({
  createEnterpriseLogger:
    "moz-src:///toolkit/components/enterprise/modules/EnterpriseCommon.sys.mjs",
  log: () => lazy.createEnterpriseLogger("ConsoleProxyBypassFilter"),
  ProxyService: {
    service: "@mozilla.org/network/protocol-proxy-service;1",
    iid: Ci.nsIProtocolProxyService,
  },
});

const MAX_UINT32 = 0xffffffff;

/**
 * Forces traffic to the enterprise console host to use a direct connection,
 * regardless of how a proxy was configured, to prevent breaking the console
 * connection.
 */
export const ConsoleProxyBypassFilter = {
  QueryInterface: ChromeUtils.generateQI(["nsIProtocolProxyFilter"]),

  /** @type {string|null} Hostname of the enterprise console, or null if unset. */
  _consoleHost: null,
  /** @type {boolean} Whether the filter is registered with the proxy service. */
  _registered: false,

  /**
   * Registers the filter and sets the console host to bypass.
   *
   * @param {string} consoleHost Hostname of the enterprise console.
   */
  register(consoleHost) {
    this._consoleHost = consoleHost;
    this._registered = true;
    // This filter is registered with the highest priority so it is applied any other filters.
    lazy.ProxyService.registerFilter(this, MAX_UINT32);
  },

  /**
   * Unregisters the filter and clears the console host.
   */
  unregister() {
    if (!this._registered) {
      return;
    }
    this._registered = false;
    this._consoleHost = null;
    try {
      lazy.ProxyService.unregisterFilter(this);
    } catch (e) {
      lazy.log.error("Failed to unregister proxy filter:", e);
    }
  },

  /**
   * @see nsIProtocolProxyFilter
   * @param {nsIURI} uri The URI the proxy settings apply to.
   * @param {nsIProxyInfo} proxy The proxy resolved for the URI, or null.
   * @param {nsIProxyProtocolFilterResult} callback Receives the result.
   */
  applyFilter(uri, proxy, callback) {
    let host;
    try {
      host = uri.host;
    } catch {
      // Some URIs (e.g. about:) have no host and never match the console.
      host = null;
    }
    if (this._consoleHost && host === this._consoleHost) {
      // Passing null forces a direct connection.
      callback.onProxyFilterResult(null);
      return;
    }
    callback.onProxyFilterResult(proxy);
  },
};
