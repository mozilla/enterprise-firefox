/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  MerinoClient: "moz-src:///browser/components/urlbar/MerinoClient.sys.mjs",
  PersistentCache: "resource://newtab/lib/PersistentCache.sys.mjs",
});

import {
  actionTypes as at,
  actionCreators as ac,
} from "resource://newtab/common/Actions.mjs";

const CACHE_KEY = "stocks_feed";
const MERINO_CLIENT_KEY = "HNT_STOCKS_FEED";
const MERINO_PROVIDER = ["polygon"];
const STOCKS_UPDATE_TIME = 15 * 60 * 1000; // 15 minutes
const MERINO_TIMEOUT_MS = 5000;

const PREF_WIDGETS_STOCKS_ENABLED = "widgets.stocks.enabled";
const PREF_WIDGETS_SYSTEM_STOCKS_ENABLED = "widgets.system.stocks.enabled";

/**
 * Periodically fetches the default-ETF stock snapshots from Merino for HNT and
 * mirrors them into the `Stocks` Redux slice.
 */
export class StocksFeed {
  constructor() {
    this.loaded = false;
    this.merino = null;
    this.tickers = [];
    this.lastUpdated = null;
    this.fetchTimer = null;
    this.fetchIntervalMs = STOCKS_UPDATE_TIME;
    this.fetchGeneration = 0;
    this.cache = this.PersistentCache(CACHE_KEY, true);
  }

  isEnabled() {
    const { values } = this.store.getState().Prefs;
    const userValue = values[PREF_WIDGETS_STOCKS_ENABLED];
    const systemValue = values[PREF_WIDGETS_SYSTEM_STOCKS_ENABLED];
    const experimentValue =
      values.trainhopConfig?.widgets?.stocksEnabled || false;
    return userValue && (systemValue || experimentValue);
  }

  async init() {
    await this.loadStocks();
  }

  stopFetching() {
    // Change the generation number so that a fetch() still running when we stop
    // will notice it is out of date and skip updating state or starting a new
    // timer.
    this.fetchGeneration++;
    // Always clear the refresh timer. loadStocks() can start it when it finds
    // cached data, without ever creating a Merino client, so only clearing it
    // when a client exists would leave the timer running and keep fetching after
    // the widget is turned off. Also reset lastUpdated so turning the widget back
    // on sends a fresh update.
    this.clearTimeout(this.fetchTimer);
    this.fetchTimer = null;
    this.merino = null;
    this.tickers = [];
    this.lastUpdated = null;
  }

  restartFetchTimer(ms = this.fetchIntervalMs) {
    this.clearTimeout(this.fetchTimer);
    this.fetchTimer = this.setTimeout(() => {
      this.fetch();
    }, ms);
  }

  async loadStocks() {
    const cached = (await this.cache.get()) || {};
    const { stocks } = cached;
    if (
      !stocks?.lastUpdated ||
      this.Date().now() - stocks.lastUpdated >= STOCKS_UPDATE_TIME
    ) {
      await this.fetch();
    } else if (!this.lastUpdated) {
      this.tickers = stocks.tickers || [];
      this.lastUpdated = stocks.lastUpdated;
      this.update();
      const age = this.Date().now() - stocks.lastUpdated;
      this.restartFetchTimer(Math.max(0, STOCKS_UPDATE_TIME - age));
    }
    this.loaded = true;
  }

  // `query` defaults to "" (the default ETF set). A non-empty query (e.g.
  // "$AAPL") performs an individual lookup through the same path; unused for now.
  async fetch(query = "") {
    const generation = this.fetchGeneration;
    try {
      if (!this.merino) {
        this.merino = await this.MerinoClient(MERINO_CLIENT_KEY);
      }
      if (generation !== this.fetchGeneration) {
        return; // torn down during client creation
      }
      this.restartFetchTimer();
      const tickers = await this._fetchHelper(query);
      if (generation !== this.fetchGeneration) {
        return; // torn down during fetch
      }
      if (tickers.length) {
        this.tickers = tickers;
        this.lastUpdated = this.Date().now();
        await this.cache.set("stocks", {
          tickers: this.tickers,
          lastUpdated: this.lastUpdated,
        });
      }
      this.update();
    } catch (e) {
      console.error("StocksFeed fetch failed", e);
    }
  }

  /**
   * Thin wrapper around the Merino call so tests can simulate responses.
   */
  async _fetchHelper(query = "") {
    try {
      if (!this.merino) {
        return [];
      }
      const result = await this.merino.fetch({
        query,
        providers: MERINO_PROVIDER,
        timeoutMs: MERINO_TIMEOUT_MS,
        otherParams: { source: "newtab" },
      });
      const values = result?.[0]?.custom_details?.polygon?.values;
      return Array.isArray(values) ? values : [];
    } catch (e) {
      console.error("StocksFeed Merino request failed", e);
      return [];
    }
  }

  update() {
    this.store.dispatch(
      ac.BroadcastToContent({
        type: at.WIDGETS_STOCKS_UPDATE,
        data: {
          tickers: this.tickers,
          lastUpdated: this.lastUpdated,
        },
      })
    );
  }

  async onPrefChangedAction(action) {
    switch (action.data.name) {
      case PREF_WIDGETS_STOCKS_ENABLED:
      case PREF_WIDGETS_SYSTEM_STOCKS_ENABLED:
      case "trainhopConfig": {
        const enabled = this.isEnabled();
        if (enabled && !this.loaded) {
          await this.loadStocks();
        } else if (!enabled && this.loaded) {
          this.stopFetching();
          this.loaded = false;
        }
        break;
      }
    }
  }

  async onAction(action) {
    switch (action.type) {
      case at.INIT:
        if (this.isEnabled() && !this.loaded) {
          await this.init();
        }
        break;
      case at.UNINIT:
        this.stopFetching();
        this.loaded = false;
        break;
      case at.SYSTEM_TICK:
        if (this.isEnabled()) {
          await this.loadStocks();
        }
        break;
      case at.PREF_CHANGED:
        await this.onPrefChangedAction(action);
        break;
    }
  }
}

/**
 * Thin wrappers around external tools so tests can stub them.
 */
StocksFeed.prototype.MerinoClient = name => {
  return new lazy.MerinoClient(name, { allowOhttp: false });
};
StocksFeed.prototype.PersistentCache = (...args) => {
  return new lazy.PersistentCache(...args);
};
StocksFeed.prototype.Date = () => {
  return Date;
};
StocksFeed.prototype.setTimeout = (...args) => {
  return lazy.setTimeout(...args);
};
StocksFeed.prototype.clearTimeout = (...args) => {
  return lazy.clearTimeout(...args);
};
