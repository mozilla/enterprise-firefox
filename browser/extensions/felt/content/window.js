/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { E10SUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/E10SUtils.sys.mjs"
);

// Will at least make move forward marionette
Services.obs.notifyObservers(window, "browser-delayed-startup-finished");

function load_sso_url() {
  let browser = document.getElementById("browser");

  let oa = E10SUtils.predictOriginAttributes({ browser });
  browser.setAttribute("maychangeremoteness", "true");

  const SOURCE_URI = Services.prefs.getStringPref("browser.felt.sso_url");

  browser.setAttribute(
    "remoteType",
    E10SUtils.getRemoteTypeForURI(
      SOURCE_URI,
      /* remote */ true,
      /* fission */ true,
      E10SUtils.WEB_REMOTE_TYPE,
      null,
      oa
    )
  );

  console.debug("Load SSO Page: ", SOURCE_URI);
  browser.fixupAndLoadURIString(SOURCE_URI, {
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });

  document.querySelector(".felt-login__form").classList.add("is-hidden");
  document
    .querySelector(".felt-login__sso")
    .classList.remove("is-hidden");
}

async function init() {
  let browser = document.getElementById("browser");
  browser.setAttribute("remote", "true");

  const enabled_pref = "browser.felt.enabled";
  if (!Services.prefs.getBoolPref(enabled_pref, false)) {
    Services.prefs.addObserver(enabled_pref, () => {
      if (Services.prefs.getBoolPref(enabled_pref, false)) {
        listenFormEmailSubmission();
      }
    });
  } else {
    listenFormEmailSubmission();
  }
}

function listenFormEmailSubmission() {
  const signInBtn = document.getElementById("felt-login__form-sign-in-btn");
  const emailInput = document.getElementById("felt-login__form-email")

  function handleSubmit() {
    load_sso_url()
  }

  emailInput.addEventListener("input", () => {
    signInBtn.disabled = emailInput.value.trim() === "";
  });

  // <moz-button> does not trigger the native "submit" event on <form>
  // so we manually handle submission on button click and when Enter is pressed
  signInBtn.addEventListener("click", () => {
    handleSubmit();
  });
  emailInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !signInBtn.disabled) {
      e.preventDefault();
      handleSubmit();
    }
  });
}

window.addEventListener(
  "load",
  () => {
    window.gBrowser = {
      get selectedBrowser() {
        let rv = document.getElementById("browser");
        return rv;
      },

      get tabs() {
        let ts = [
          {
            linkedBrowser: this.selectedBrowser,
          },
        ];
        return ts;
      },

      get selectedTab() {
        return this.tabs[0];
      },

      set selectedTab(tab) {
        // Synthesize a custom TabSelect event to indicate that a tab has been
        // selected even when we don't change it.
        const event = new window.CustomEvent("TabSelect", {
          bubbles: true,
          cancelable: false,
          detail: {
            previousTab: this.selectedTab,
          },
        });

        window.document.dispatchEvent(event);
      },

      getTabForBrowser() {
        return window;
      },

      addEventListener() {
        this.selectedBrowser.addEventListener(...arguments);
      },

      removeEventListener() {
        this.selectedBrowser.removeEventListener(...arguments);
      },
    };

    // Last notification required for marionette to work
    Services.obs.notifyObservers(window, "browser-idle-startup-tasks-finished");
    init();
  },
  true
);
