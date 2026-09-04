/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { FeltStorage } = ChromeUtils.importESModule(
  "resource://gre/modules/enterprise/FeltStorage.sys.mjs"
);

// Result slot read by ShowEnterpriseConsoleSetup() in nsAppRunner.cpp:
// 1 means an address was persisted and the application should relaunch,
// anything else aborts startup.
const RESULT_INDEX = 0;
const RESULT_SAVED = 1;

function parseConsoleAddress(value) {
  let url;
  try {
    url = new URL(value.trim());
  } catch (e) {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return null;
  }
  return url.href;
}

let saving = false;

function showError(errorBar, l10nId) {
  document.l10n.setAttributes(errorBar, l10nId);
  errorBar.hidden = false;
}

async function save(paramBlock, addressInput, saveBtn, errorBar) {
  if (saving) {
    return;
  }

  const address = parseConsoleAddress(addressInput.value);
  if (!address) {
    showError(errorBar, "felt-console-setup-invalid-address");
    return;
  }

  saving = true;
  saveBtn.disabled = true;
  errorBar.hidden = true;
  try {
    await FeltStorage.init();
    await FeltStorage.persistConsoleAddress(address);
  } catch (e) {
    console.error("Failed to persist the console address", e);
    showError(errorBar, "felt-console-setup-save-failed");
    saving = false;
    saveBtn.disabled = false;
    return;
  }

  paramBlock.SetInt(RESULT_INDEX, RESULT_SAVED);
  window.close();
}

window.addEventListener("load", () => {
  const paramBlock = window.arguments[0].QueryInterface(Ci.nsIDialogParamBlock);
  const addressInput = document.getElementById("console-setup-address");
  const saveBtn = document.getElementById("console-setup-save-btn");
  const quitBtn = document.getElementById("console-setup-quit-btn");
  const errorBar = document.getElementById("console-setup-error");

  addressInput.focus();

  addressInput.addEventListener("input", () => {
    saveBtn.disabled = saving || addressInput.value.trim() === "";
    errorBar.hidden = true;
  });

  // <moz-button> does not trigger the native "submit" event on <form>
  // so we manually handle submission on button click and when Enter is pressed
  saveBtn.addEventListener("click", () => {
    save(paramBlock, addressInput, saveBtn, errorBar);
  });
  addressInput.addEventListener("keydown", e => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (!saveBtn.disabled) {
        save(paramBlock, addressInput, saveBtn, errorBar);
      }
    }
  });

  quitBtn.addEventListener("click", () => {
    window.close();
  });
  window.addEventListener("keydown", e => {
    if (e.key === "Escape") {
      window.close();
    }
  });
});
