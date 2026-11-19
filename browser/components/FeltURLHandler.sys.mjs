/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineLazyGetter(
  lazy,
  "feltL10n",
  () =>
    new Localization(
      ["toolkit/enterprise/felt.ftl", "branding/brand.ftl"],
      true
    )
);

ChromeUtils.defineESModuleGetters(lazy, {
  FeltStorage: "moz-src:///toolkit/components/felt/FeltStorage.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "legacyPendingURLsPath", () =>
  PathUtils.join(
    Services.dirsvc.get("ProfD", Ci.nsIFile).path,
    "pendingURLs.json"
  )
);

export const FELT_OPEN_WINDOW_DISPOSITION = {
  DEFAULT: 0,
  NEW_WINDOW: 1,
  NEW_PRIVATE_WINDOW: 2,
};

const ALLOWED_EXTERNAL_SCHEMES = new Set(["http", "https", "file"]);

/**
 * Parses an external URL payload and rejects any URL whose scheme is not in
 * ALLOWED_EXTERNAL_SCHEMES. Callers load these with fromExternal: true, which
 * stops a principal-inheriting URL from picking up the current document's
 * principal.
 *
 * @param {object} payload
 *   External URL and optional window disposition.
 * @returns {{url: string, disposition: number}|null}
 *   The payload with defaults, or null if the URL is invalid or its scheme is
 *   not allowed. An empty URL is kept, and opens the default page.
 */
export function sanitizeFeltURLPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const url = payload.url === undefined ? "" : payload.url;
  if (typeof url !== "string") {
    return null;
  }
  if (url) {
    try {
      if (!ALLOWED_EXTERNAL_SCHEMES.has(Services.io.newURI(url).scheme)) {
        return null;
      }
    } catch {
      return null;
    }
  }
  return {
    url,
    disposition: payload.disposition ?? FELT_OPEN_WINDOW_DISPOSITION.DEFAULT,
  };
}

// Queue for Felt external link handling
// URL requests are stored here when they arrive via command line (before Felt extension loads)
// FeltProcessParent imports this module and manages forwarding from this queue.
//
// The stored copy mirrors the queue so an app restart can carry it over
// (bug 2032092). FeltStorage encrypts it, and only a launch that is itself a
// restart reads it back, so URLs queued by one session are never reopened by an
// unrelated one.

export const gFeltPendingURLs = {
  _pendingURLs: [],
  _ready: false,
  _initPromise: null,
  _writes: Promise.resolve(),
  _writeQueued: false,

  async init() {
    if (!Services.felt?.isFeltUI()) {
      throw new Error("The Felt URL queue is only used in the Felt UI process");
    }
    if (this._ready) {
      return;
    }
    if (!this._initPromise) {
      this._initPromise = this._restore()
        .catch(error => {
          console.error("Failed to restore pending Felt URLs", error);
        })
        .finally(() => {
          this._ready = true;
          this._initPromise = null;
        });
    }
    await this._initPromise;
  },

  async _restore() {
    const queue = this._pendingURLs;
    // Read before awaiting: requesting a restart sets MOZ_APP_RESTART in this
    // process, which would make a cold launch look like a restart.
    const wasRestarted = Services.startup.wasRestarted;
    // Builds before bug 2073035 kept the queue as plaintext in the scratch
    // profile, which outlives upgrades. It is removed unread.
    await IOUtils.remove(lazy.legacyPendingURLsPath, {
      ignoreAbsent: true,
    }).catch(error => {
      console.error("Failed to remove legacy pending Felt URLs", error);
    });
    await lazy.FeltStorage.init();
    if (!wasRestarted) {
      await lazy.FeltStorage.clearPendingURLs();
      return;
    }
    const restored = await lazy.FeltStorage.readPendingURLs();
    // clear() replaces the queue. A signout while a stalled keystore was still
    // decrypting must not hand the previous session's URLs to the next one.
    if (queue !== this._pendingURLs) {
      return;
    }
    if (restored.length) {
      this._pendingURLs.unshift(
        ...restored.map(sanitizeFeltURLPayload).filter(Boolean)
      );
      this._persist();
    }
  },

  /**
   * Brings the stored copy in line with the queue. Writes are chained so a
   * slower earlier one cannot land after a later one and resurrect URLs that
   * have since been opened. They also wait for init(), so a URL that arrives
   * on the command line before the restore has run cannot overwrite the
   * stored queue before it has been read. A write that has not started yet
   * reads the queue when it does, so later updates join it rather than each
   * encrypting and saving the whole queue again. clear() reaches FeltStorage
   * without waiting on the chain, which is how a write that was encrypting
   * when it ran gets dropped.
   *
   * @returns {Promise<void>} Resolves once this update has been written.
   */
  _persist() {
    if (this._writeQueued) {
      return this._writes;
    }
    this._writeQueued = true;
    this._writes = this._writes
      .then(() => this.init())
      .then(async () => {
        this._writeQueued = false;
        await lazy.FeltStorage.storePendingURLs(this._pendingURLs);
      })
      .catch(error => {
        this._writeQueued = false;
        console.error("Failed to store pending Felt URLs", error);
      });
    return this._writes;
  },

  [Symbol.iterator]() {
    return this._pendingURLs[Symbol.iterator]();
  },

  push(payload) {
    if (!Services.felt?.isFeltUI()) {
      throw new Error("The Felt URL queue is only used in the Felt UI process");
    }
    const rv = this._pendingURLs.push(payload);
    this._persist();
    return rv;
  },

  get length() {
    return this._pendingURLs.length;
  },

  clear() {
    if (!Services.felt?.isFeltUI()) {
      throw new Error("The Felt URL queue is only used in the Felt UI process");
    }
    this._pendingURLs = [];
    // Not chained behind _writes, so a write stuck on the keystore cannot
    // keep the stored queue around past a signout.
    lazy.FeltStorage.clearPendingURLs().catch(error => {
      console.error("Failed to clear stored Felt URLs", error);
    });
    this._persist();
  },
};

if (Services.felt?.isFeltUI()) {
  gFeltPendingURLs.init().catch(error => {
    console.error(`Failed to initialize Felt pending URL storage: ${error}`);
  });
}

let lastNotificationShown = 0;
let gFeltFirefoxReadyNotified = false;

export function isFeltFirefoxWindowReady() {
  if (gFeltFirefoxReadyNotified) {
    return true;
  }
  try {
    const { isFeltFirefoxWindowReady: isReady } = ChromeUtils.importESModule(
      "chrome://felt/content/FeltProcessParent.sys.mjs"
    );
    if (isReady()) {
      gFeltFirefoxReadyNotified = true;
      return true;
    }
  } catch {
    // Extension not loaded yet.
  }
  return false;
}

export function waitForFeltFirefoxWindowReady() {
  if (isFeltFirefoxWindowReady()) {
    return Promise.resolve();
  }
  return new Promise(resolve => {
    let observer = {
      observe: () => {
        gFeltFirefoxReadyNotified = true;
        Services.obs.removeObserver(observer, "felt-firefox-window-ready");
        resolve();
      },
    };
    Services.obs.addObserver(observer, "felt-firefox-window-ready");
  });
}

export function resetFeltFirefoxWindowReady() {
  gFeltFirefoxReadyNotified = false;
}

// Queue a URL to be opened in Firefox via Felt IPC.
// Note: We don't pass triggeringPrincipal because all command-line URLs use
// gSystemPrincipal (see resolveURIInternal), and the receiving Firefox side
// should use system principal for externally-triggered URLs.
export function queueFeltURL(payload) {
  payload = sanitizeFeltURLPayload(payload);
  if (!payload) {
    console.error("Refusing to queue invalid Felt URL");
    return;
  }

  let isReady = isFeltFirefoxWindowReady();
  try {
    const { queueURL } = ChromeUtils.importESModule(
      "chrome://felt/content/FeltProcessParent.sys.mjs"
    );
    queueURL(payload);
  } catch (e) {
    console.warn(
      `Retrying to queue url ${payload.url} after initial failure:`,
      e
    );
    gFeltPendingURLs.push(payload);
    Services.cpmm.sendAsyncMessage("FeltParent:ForceFeltFocus", {});
  }

  // On Linux (and as fallback for other platforms), show a notification
  // if the action was queued before Firefox is ready
  if (
    !isReady &&
    payload.disposition !== FELT_OPEN_WINDOW_DISPOSITION.DEFAULT
  ) {
    showFeltPendingActionNotification();
  }
}

function showFeltPendingActionNotification() {
  try {
    let now = Date.now();
    // Throttle notifications to avoid spam if user clicks multiple times
    if (lastNotificationShown && now - lastNotificationShown < 5000) {
      return;
    }
    lastNotificationShown = now;

    let alertsService = Cc["@mozilla.org/alerts-service;1"]?.getService(
      Ci.nsIAlertsService
    );
    if (!alertsService) {
      return;
    }

    let alert = Cc["@mozilla.org/alert-notification;1"].createInstance(
      Ci.nsIAlertNotification
    );
    let body = lazy.feltL10n.formatValueSync(
      "felt-pending-action-notification"
    );
    alert.init(
      "felt-pending-action",
      "chrome://branding/content/icon64.png",
      "",
      body,
      false,
      "",
      null,
      null,
      null,
      null,
      null,
      false
    );
    alertsService.showAlert(alert);
  } catch {
    // Notification service may not be available on all platforms
  }
}
