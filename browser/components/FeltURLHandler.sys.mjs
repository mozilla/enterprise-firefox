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

ChromeUtils.defineLazyGetter(lazy, "pendingURLsPath", () =>
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

/**
 * Parses an external URL payload and rejects chrome: URLs, matching Firefox's
 * external-opening policy. Loaders enforce the remaining restrictions.
 *
 * @param {object} payload
 *   External URL and optional window disposition.
 * @returns {{url: string, disposition: number}|null}
 *   The payload with defaults, or null if the URL is invalid or uses chrome:.
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
      if (Services.io.newURI(url).schemeIs("chrome")) {
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
// Update restarts (bug 2032092) inherit a fresh handoff key through the
// environment. Only ciphertext is written to the scratch profile; a later,
// unrelated launch cannot restore it using a persistent OS-account key.
const RESTART_KEY_ENV = "MOZ_FELT_PENDING_URLS_KEY";
const MAX_HANDOFF_BYTES = 1024 * 1024;
const MAX_HANDOFF_AGE_MS = 30 * 60 * 1000;

export const gFeltPendingURLs = {
  _pendingURLs: [],
  _ready: false,
  _initPromise: null,
  _updateRestart: false,

  async init() {
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
    const inheritedKey = Services.env.get(RESTART_KEY_ENV);
    Services.env.set(RESTART_KEY_ENV, "");
    if (!inheritedKey) {
      await IOUtils.remove(lazy.pendingURLsPath, { ignoreAbsent: true });
      return;
    }

    let bytes;
    try {
      bytes = await IOUtils.read(lazy.pendingURLsPath, {
        maxBytes: MAX_HANDOFF_BYTES + 1,
      });
    } finally {
      await IOUtils.remove(lazy.pendingURLsPath, { ignoreAbsent: true });
    }
    if (bytes.length > MAX_HANDOFF_BYTES || inheritedKey.length > 1024) {
      return;
    }

    const key = await crypto.subtle.importKey(
      "jwk",
      JSON.parse(inheritedKey),
      "AES-GCM",
      false,
      ["decrypt"]
    );
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bytes.subarray(0, 12),
        additionalData: new TextEncoder().encode(lazy.pendingURLsPath),
      },
      key,
      bytes.subarray(12)
    );
    const restored = JSON.parse(new TextDecoder().decode(plaintext));
    const age = Date.now() - restored.createdAt;
    if (
      restored.version !== 1 ||
      !Number.isFinite(restored.createdAt) ||
      age < 0 ||
      age > MAX_HANDOFF_AGE_MS ||
      !Array.isArray(restored.urls)
    ) {
      return;
    }
    this._pendingURLs.unshift(
      ...restored.urls.map(sanitizeFeltURLPayload).filter(Boolean)
    );
  },

  observe() {
    this._updateRestart = true;
  },

  async persistForRestart() {
    await this.init();
    Services.env.set(RESTART_KEY_ENV, "");
    if (!this._updateRestart || !this._pendingURLs.length) {
      return;
    }
    try {
      const plaintext = new TextEncoder().encode(
        JSON.stringify({
          version: 1,
          createdAt: Date.now(),
          urls: this._pendingURLs,
        })
      );
      if (plaintext.length + 12 + 16 > MAX_HANDOFF_BYTES) {
        throw new Error("Pending Felt URLs exceed the restart handoff limit");
      }
      const key = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"]
      );
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: new TextEncoder().encode(lazy.pendingURLsPath),
        },
        key,
        plaintext
      );
      const bytes = new Uint8Array(iv.length + ciphertext.byteLength);
      bytes.set(iv);
      bytes.set(new Uint8Array(ciphertext), iv.length);
      await IOUtils.write(lazy.pendingURLsPath, bytes, {
        tmpPath: `${lazy.pendingURLsPath}.tmp`,
      });
      Services.env.set(
        RESTART_KEY_ENV,
        JSON.stringify(await crypto.subtle.exportKey("jwk", key))
      );
    } catch (error) {
      console.error("Failed to persist pending Felt URLs", error);
    }
  },

  [Symbol.iterator]() {
    return this._pendingURLs[Symbol.iterator]();
  },

  push(payload) {
    return this._pendingURLs.push(payload);
  },

  get length() {
    return this._pendingURLs.length;
  },

  clear() {
    this._pendingURLs = [];
  },
};

if (Services.felt?.isFeltUI()) {
  gFeltPendingURLs.init().catch(error => {
    console.error(`Failed to initialize Felt pending URL storage: ${error}`);
  });
  Services.obs.addObserver(gFeltPendingURLs, "felt-update-restart");
  IOUtils.profileBeforeChange.addBlocker(
    "FeltURLHandler: hand off pending URLs for an update restart",
    async () => {
      if (Services.startup.restarting) {
        await gFeltPendingURLs.persistForRestart();
      }
    }
  );
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
