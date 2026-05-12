/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PersistentCache: "resource://newtab/lib/PersistentCache.sys.mjs",
});

import {
  actionTypes as at,
  actionCreators as ac,
} from "resource://newtab/common/Actions.mjs";

const PREF_SPORTS_ENABLED = "widgets.sportsWidget.enabled";
const FOLLOW_STATE = "sports-follow-state";
const CACHE_KEY = "sports_feed";

/**
 * Manages persistent state for the Sports widget (selected teams and widget
 * state), syncing with PersistentCache so state survives page refreshes.
 */
export class SportsFeed {
  constructor() {
    this.initialized = false;
    this.cache = this.PersistentCache(CACHE_KEY, true);
  }

  get enabled() {
    const prefs = this.store.getState()?.Prefs.values;
    return !!prefs?.[PREF_SPORTS_ENABLED];
  }

  async init() {
    this.initialized = true;
    await this.syncState();
  }

  // On startup, read whatever was saved to disk and send it to the UI.
  async syncState() {
    const cachedData = (await this.cache.get()) || {};
    const { widgetState, selectedTeams } = cachedData;

    if (widgetState) {
      this.store.dispatch(
        ac.BroadcastToContent({
          type: at.WIDGETS_SPORTS_SET_WIDGET_STATE,
          data: widgetState,
        })
      );
    }

    if (selectedTeams) {
      this.store.dispatch(
        ac.BroadcastToContent({
          type: at.WIDGETS_SPORTS_SET_SELECTED_TEAMS,
          data: selectedTeams,
        })
      );
    }
  }

  async onPrefChangedAction(action) {
    if (
      action.data.name === PREF_SPORTS_ENABLED &&
      this.enabled &&
      !this.initialized
    ) {
      await this.init();
    }
  }

  async onAction(action) {
    switch (action.type) {
      case at.INIT:
        if (this.enabled) {
          await this.init();
        }
        break;
      case at.PREF_CHANGED:
        await this.onPrefChangedAction(action);
        break;
      // User changed the widget state — save it and send the updated state to the UI.
      case at.WIDGETS_SPORTS_CHANGE_WIDGET_STATE:
        if (action.data !== FOLLOW_STATE) {
          await this.cache.set("widgetState", action.data);
        }
        this.store.dispatch(
          ac.BroadcastToContent({
            type: at.WIDGETS_SPORTS_SET_WIDGET_STATE,
            data: action.data,
          })
        );
        break;
      // User changed their team selection — save it and send the updated list to the UI.
      case at.WIDGETS_SPORTS_CHANGE_SELECTED_TEAMS:
        await this.cache.set("selectedTeams", action.data);
        this.store.dispatch(
          ac.BroadcastToContent({
            type: at.WIDGETS_SPORTS_SET_SELECTED_TEAMS,
            data: action.data,
          })
        );
        break;
    }
  }
}

SportsFeed.prototype.PersistentCache = (...args) => {
  return new lazy.PersistentCache(...args);
};
