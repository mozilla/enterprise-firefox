/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { E10SUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/E10SUtils.sys.mjs"
);

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

  browser.fixupAndLoadURIString(SOURCE_URI, {
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });
}

async function init() {
  let browser = document.getElementById("browser");
  browser.setAttribute("remote", "true");

  const enabled_pref = "browser.felt.enabled";
  if (!Services.prefs.getBoolPref(enabled_pref, false)) {
    Services.prefs.addObserver(enabled_pref, () => {
      if (Services.prefs.getBoolPref(enabled_pref, false)) {
        load_sso_url();
      }
    });
  } else {
    load_sso_url();
  }
}

window.addEventListener(
  "load",
  () => {
    init();
  },
  true
);
