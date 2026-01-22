/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AIFeature } from "chrome://global/content/ml/AIFeature.sys.mjs";
import { TranslationsUtils } from "chrome://global/content/translations/TranslationsUtils.mjs";

const lazy = {};

ChromeUtils.defineLazyGetter(lazy, "console", () => {
  return console.createInstance({
    maxLogLevelPref: "browser.translations.logLevel",
    prefix: "Translations",
  });
});

const AI_CONTROL_DEFAULT_PREF = "browser.ai.control.default";
const AI_CONTROL_TRANSLATIONS_PREF = "browser.ai.control.translations";
const TRANSLATIONS_ENABLE_PREF = "browser.translations.enable";

/**
 * AIFeature implementation for translations.
 */
export class TranslationsFeature extends AIFeature {
  /**
   * Feature identifier for translations.
   *
   * @returns {string}
   */
  static get id() {
    return "translations";
  }

  /**
   * Enables translations via preferences.
   *
   * @returns {Promise<void>}
   */
  static async enable() {
    if (TranslationsFeature.isManagedByPolicy) {
      throw new Error(
        "Cannot enable Translations: controlled by enterprise policy"
      );
    }

    Services.prefs.setStringPref(AI_CONTROL_TRANSLATIONS_PREF, "enabled");
    Services.prefs.setBoolPref(TRANSLATIONS_ENABLE_PREF, true);
  }

  /**
   * Disables translations via preferences and removes artifacts.
   *
   * @returns {Promise<void>}
   */
  static async disable() {
    if (TranslationsFeature.isManagedByPolicy) {
      throw new Error(
        "Cannot disable Translations: controlled by enterprise policy"
      );
    }

    Services.prefs.setStringPref(AI_CONTROL_TRANSLATIONS_PREF, "blocked");
    Services.prefs.setBoolPref(TRANSLATIONS_ENABLE_PREF, false);

    await TranslationsFeature.#deleteAllArtifacts();
  }

  /**
   * Resets translations preferences and removes artifacts.
   *
   * @returns {Promise<void>}
   */
  static async reset() {
    if (TranslationsFeature.isManagedByPolicy) {
      throw new Error(
        "Cannot reset Translations: controlled by enterprise policy"
      );
    }

    Services.prefs.clearUserPref(AI_CONTROL_TRANSLATIONS_PREF);
    Services.prefs.clearUserPref(TRANSLATIONS_ENABLE_PREF);

    await TranslationsFeature.#deleteAllArtifacts();
  }

  /**
   * Returns true if the Translations feature is enable, otherwise false.
   *
   * @returns {boolean}
   */
  static get isEnabled() {
    return (
      TranslationsFeature.isAllowed &&
      Services.prefs.getBoolPref(TRANSLATIONS_ENABLE_PREF, false)
    );
  }

  /**
   * Returns true if the Translations feature is allowed by AI control preferences, otherwise false.
   *
   * @returns {boolean}
   */
  static get isAllowed() {
    const translationsPref = Services.prefs.getStringPref(
      AI_CONTROL_TRANSLATIONS_PREF,
      "default"
    );

    switch (translationsPref) {
      case "blocked": {
        // The feature has been explicitly blocked.
        return false;
      }
      case "enabled": {
        // The feature has been explicitly enabled.
        return true;
      }
      case "default": {
        // The feature's enabled state has not been explicity set,
        // so we need to continue on to look at the default AI settings.
        break;
      }
      default: {
        lazy.console.warn(
          "Invalid preference value for",
          AI_CONTROL_TRANSLATIONS_PREF,
          translationsPref
        );

        return false;
      }
    }

    const defaultPref = Services.prefs.getStringPref(
      AI_CONTROL_DEFAULT_PREF,
      "available"
    );

    switch (defaultPref) {
      case "available": {
        return true;
      }
      case "blocked": {
        return false;
      }
      default: {
        lazy.console.warn(
          "Invalid preference value for",
          AI_CONTROL_DEFAULT_PREF,
          defaultPref
        );

        return false;
      }
    }
  }

  /**
   * Returns true if the Translations feature is blocked, otherwise false.
   *
   * @returns {boolean}
   */
  static get isBlocked() {
    return !TranslationsFeature.isAllowed;
  }

  /**
   * Returns true if the enabled state of the Translations feature is already
   * managed by an enterprise policy and is therefore immutable, otherwise false.
   *
   * @returns {boolean}
   */
  static get isManagedByPolicy() {
    return (
      Services.prefs.prefIsLocked(TRANSLATIONS_ENABLE_PREF) ||
      Services.prefs.prefIsLocked(AI_CONTROL_TRANSLATIONS_PREF)
    );
  }

  /**
   * Deletes translations artifacts.
   *
   * @returns {Promise<void>}
   */
  static async #deleteAllArtifacts() {
    try {
      await TranslationsUtils.deleteAllLanguageFiles();
    } catch (error) {
      lazy.console.error(
        "Failed to delete Translations language files.",
        error
      );
    }
  }
}
