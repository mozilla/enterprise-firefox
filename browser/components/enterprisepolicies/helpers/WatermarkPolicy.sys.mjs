/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * This module implements the Watermark policy, which draws a tiled, diagonal
 * watermark over a configurable list of websites.
 *
 * The list of affected pages is given as an array of MatchPattern strings, as
 * documented at
 * https://developer.mozilla.org/en-US/Add-ons/WebExtensions/Match_patterns.
 *
 * The configuration is provided to content processes over the WatermarkPolicy
 * actor's own message channel (the child queries "Watermark:GetConfig" when it
 * is created, and the parent pushes "Watermark:Refresh" when the policy
 * changes), and the actual drawing happens in the content process from
 * WatermarkChild.
 * Rather than registering the WatermarkPolicy actor for every http(s) page
 * (which would mean creating it, and running its DOMContentLoaded/pageshow
 * listeners, on every navigation everywhere, even with no policy applied),
 * this module registers the actor itself with `matches` set to the policy's
 * own Match list (plus `about:reader` and `view-source:`, which wrap another
 * URL, so Reader Mode and View Source of matching pages are covered too), so
 * the actor only ever gets constructed for pages that can possibly be
 * watermarked. It (re-)registers the actor whenever the policy is applied or
 * changed, and unregisters it when the policy is removed.
 */

const PREF_LOGLEVEL = "browser.policies.loglevel";

const WATERMARK_ACTOR_NAME = "WatermarkPolicy";

// Wrapper-scheme pages that show the content of another URL (Reader Mode and
// View Source). The actor is registered for these in addition to the policy's
// site patterns; WatermarkChild then matches the wrapped URL before drawing.
const READER_MATCH_PATTERN = "about:reader?url=*";
const VIEW_SOURCE_MATCH_PATTERN = "view-source:*";

const LIST_LENGTH_LIMIT = 1000; // Same limit as in WebsiteFilter.
const DEFAULT_COLOR = "rgba(200, 0, 0, 0.5)";
const DEFAULT_FONT_SIZE = 28;
const MAX_FONT_SIZE = 64;
const DEFAULT_ANGLE = -45;
const DEFAULT_TILE_SIZE = 300;
const MIN_TILE_SIZE = 100;
const MAX_TILE_SIZE = 2048;

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  ConsoleClient:
    "moz-src:///toolkit/components/enterprise/modules/ConsoleClient.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  let { ConsoleAPI } = ChromeUtils.importESModule(
    "resource://gre/modules/Console.sys.mjs"
  );
  return new ConsoleAPI({
    prefix: "WatermarkPolicy",
    // tip: set maxLogLevel to "debug" and use log.debug() to create detailed
    // messages during development. See LOG_LEVELS in Console.sys.mjs for details.
    maxLogLevel: "error",
    maxLogLevelPref: PREF_LOGLEVEL,
  });
});

/**
 * Initial watermark configuration, needs to be validated and sanitized.
 *
 * @typedef {object} WatermarkInitialConfig
 * @property {Array<string>} [match] MatchPattern strings for the pages to watermark.
 * @property {string} [copy] Primary watermark text. Defaults to the logged in
 *   user's email, or "CONFIDENTIAL" if unavailable.
 * @property {string} [color] CSS color for the watermark text. Falls back to
 *   DEFAULT_COLOR if invalid or omitted.
 * @property {number} [fontSize] Font size in pixels, clamped to MAX_FONT_SIZE.
 * @property {number} [angle] Rotation angle in degrees for the tiled text.
 * @property {string} [secondaryCopy] Secondary line of text, supporting the
 *   "%t" (timestamp) and "%e" (email) placeholders. Defaults to "%t".
 * @property {number} [size] Tile size in pixels, clamped between
 *   MIN_TILE_SIZE and MAX_TILE_SIZE.
 *
 *
 * Watermark configuration, as constructed by WatermarkPolicy.init() and
 * provided to content processes over the WatermarkPolicy actor messages.
 *
 * @typedef {object} WatermarkConfig
 * @property {Array<string>} match MatchPattern strings for the pages to watermark.
 * @property {string} copy Primary watermark text.
 * @property {string} color CSS color for the watermark text.
 * @property {number} size Tile size in pixels.
 * @property {number} fontSize Font size in pixels.
 * @property {number} angle Rotation angle in degrees for the tiled text.
 * @property {string} secondaryCopy Secondary line of text, supporting the
 *   "%t" (timestamp) and "%e" (email) placeholders.
 * @property {string} email Logged in user's email, or "" if unavailable.
 * @property {string} [timestamp] Date the watermark was drawn/printed. Set by
 *   WatermarkChild; absent from the config published by WatermarkPolicy.
 */

// The current sanitized watermark configuration, or null when the policy
// isn't applied. Served to content processes by the WatermarkPolicy parent
// actor in response to "Watermark:GetConfig".
let currentConfig = null;

/**
 * Returns the watermark configuration currently in effect, or null when the
 * policy isn't applied.
 *
 * @returns {WatermarkConfig?}
 */
export function getWatermarkConfig() {
  return currentConfig;
}

export let WatermarkPolicy = {
  /**
   * Validates the policy's configuration, stores it for content processes to
   * query, and (re-)registers the WatermarkPolicy actor so it only runs on
   * matching pages.
   *
   * @param {WatermarkInitialConfig} params
   * @returns {Promise<void>}
   */
  async init(params) {
    let config;
    try {
      config = await sanitizeConfig(params);
    } catch (e) {
      lazy.log.error("Watermark policy has no valid matches; not applying.");
      this._unregisterActor();
      currentConfig = null;
      this._refreshOpenTabs(null);
      return;
    }

    this._registerActor(config.match);

    currentConfig = config;

    this._refreshOpenTabs(config);
  },

  /**
   * Removes the watermark from all open tabs and unregisters the actor.
   */
  cleanup() {
    this._unregisterActor();

    currentConfig = null;

    this._refreshOpenTabs(null);
  },

  /**
   * Registers the WatermarkPolicy content-process actor, restricted to the
   * given matches so it's only created for pages that can be watermarked.
   *
   * @param {Array<string>} matches MatchPattern strings for the actor's `matches`.
   */
  _registerActor(matches) {
    ChromeUtils.unregisterWindowActor(WATERMARK_ACTOR_NAME);
    ChromeUtils.registerWindowActor(WATERMARK_ACTOR_NAME, {
      parent: {
        esModuleURI:
          "moz-src:///browser/components/enterprisepolicies/helpers/WatermarkParent.sys.mjs",
      },
      child: {
        esModuleURI:
          "moz-src:///browser/components/enterprisepolicies/helpers/WatermarkChild.sys.mjs",
        events: {
          DOMContentLoaded: {},
          pageshow: {},
        },
      },
      matches: [...matches, READER_MATCH_PATTERN, VIEW_SOURCE_MATCH_PATTERN],
      messageManagerGroups: ["browsers"],
      safeForUntrustedWebProcess: true,
    });
  },

  /**
   * Unregisters the WatermarkPolicy content-process actor.
   */
  _unregisterActor() {
    ChromeUtils.unregisterWindowActor(WATERMARK_ACTOR_NAME);
  },

  /**
   * Tells the WatermarkPolicy actor of every open browser to re-apply the
   * watermark with the given configuration.
   *
   * @param {WatermarkConfig?} config Watermark configuration, or null to
   *   remove the watermark.
   */
  _refreshOpenTabs(config) {
    let windows;
    try {
      windows = lazy.BrowserWindowTracker.orderedWindows;
    } catch (_) {
      // No browser windows available (e.g. during early startup or in
      // non-browser contexts); nothing to refresh.
      return;
    }
    for (let win of windows) {
      for (let browser of win.gBrowser?.browsers ?? []) {
        try {
          browser.sendMessageToActor(
            "Watermark:Refresh",
            { config },
            "WatermarkPolicy"
          );
        } catch (_) {
          // The actor may not be available for this browser (e.g. non-web
          // documents); ignore.
        }
      }
    }
  },
};

/**
 * Returns `value` if it's a valid CSS color, or null otherwise.
 *
 * @param {*} value
 * @returns {string?}
 */
function sanitizeCSSColor(value) {
  if (typeof value !== "string") {
    return null;
  }

  value = value.trim();

  if (!CSS.supports("color", value)) {
    return null;
  }

  return value;
}

/**
 * Returns sanitized config.
 *
 * @param {WatermarkInitialConfig} _
 * @returns {Promise<WatermarkConfig>}
 */
async function sanitizeConfig({
  match = [],
  copy,
  color,
  size,
  fontSize,
  angle,
  secondaryCopy,
} = {}) {
  const validMatches = [];

  for (let i = 0; i < match.length && i < LIST_LENGTH_LIMIT; i++) {
    try {
      new MatchPattern(match[i]);
      validMatches.push(match[i]);
    } catch (e) {
      lazy.log.error(`Invalid pattern on Watermark. Match: ${match[i]}`);
    }
  }

  if (!validMatches.length) {
    throw new Error("Watermark policy has no valid matches; not applying.");
  }

  if (typeof secondaryCopy !== "string") {
    secondaryCopy = "%t";
  }

  if (typeof size !== "number") {
    size = DEFAULT_TILE_SIZE;
  }

  let email;
  if (!copy || copy?.includes?.("%e") || secondaryCopy.includes("%e")) {
    try {
      email = (await lazy.ConsoleClient.getLoggedInUserInfo())?.email;
    } catch (e) {
      lazy.log.error(`Failed to get logged in user info for Watermark: ${e}`);
    }
  }

  if (!copy) {
    copy = email || "CONFIDENTIAL";
  }
  return {
    match: validMatches,
    copy,
    secondaryCopy,
    color: sanitizeCSSColor(color) ?? DEFAULT_COLOR,
    size: Math.min(Math.max(MIN_TILE_SIZE, size), MAX_TILE_SIZE),
    fontSize: Math.min(
      typeof fontSize === "number" && fontSize > 0
        ? fontSize
        : DEFAULT_FONT_SIZE,
      MAX_FONT_SIZE
    ),
    angle: (typeof angle === "number" ? angle : DEFAULT_ANGLE) % 360,
    email: email || "",
  };
}
