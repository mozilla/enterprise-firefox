/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/** @import {SettingPaneConfig, SettingPane} from "chrome://browser/content/preferences/widgets/setting-pane.mjs" */

/**
 * Converts a friendly category name to internal pane name.
 *
 * @param {string} categoryName
 * @returns {string}
 */
export function friendlyPrefCategoryNameToInternalName(categoryName) {
  if (categoryName.startsWith("pane")) {
    return categoryName;
  }
  return (
    "pane" + categoryName.substring(0, 1).toUpperCase() + categoryName.substr(1)
  );
}

export const SettingPaneManager = {
  /** @type {Map<string, SettingPaneConfig>} */
  _data: new Map(),

  /**
   * @param {string} id
   */
  get(id) {
    if (!this._data.has(id)) {
      throw new Error(`Setting pane "${id}" not found`);
    }
    return this._data.get(id);
  },

  /**
   * @param {string} id
   * @param {SettingPaneConfig} config
   */
  registerPane(id, config) {
    if (this._data.has(id)) {
      throw new Error(`Setting pane "${id}" already registered`);
    }
    this._data.set(id, config);
    let subPane = friendlyPrefCategoryNameToInternalName(id);
    let settingPane = /** @type {SettingPane} */ (
      document.createElement("setting-pane")
    );
    settingPane.name = subPane;
    settingPane.config = config;
    settingPane.isSubPane = !!config.parent;
    document.getElementById("mainPrefPane").append(settingPane);
    window.register_module(subPane, {
      init() {
        settingPane.init();
      },
    });
  },

  /**
   * @param {Record<string, SettingPaneConfig>} paneConfigs
   */
  registerPanes(paneConfigs) {
    for (let id in paneConfigs) {
      this.registerPane(id, paneConfigs[id]);
    }
  },
};
