/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export const FELT_OPEN_WINDOW_DISPOSITION = {
  DEFAULT: 0,
  NEW_WINDOW: 1,
  NEW_PRIVATE_WINDOW: 2,
};

// Queue for Felt external link handling
// URL requests are stored here when they arrive via command line (before Felt extension loads)
// FeltProcessParent imports this module and manages forwarding from this queue
export let gFeltPendingURLs = [];

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

// Queue a URL to be opened in Firefox via Felt IPC.
// Note: We don't pass triggeringPrincipal because all command-line URLs use
// gSystemPrincipal (see resolveURIInternal), and the receiving Firefox side
// should use system principal for externally-triggered URLs.
export function queueFeltURL(payload) {
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
    let now = Cu.now();
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
    alert.init(
      "felt-pending-action",
      "chrome://branding/content/icon64.png",
      "Firefox",
      "Please wait while Firefox starts...",
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
