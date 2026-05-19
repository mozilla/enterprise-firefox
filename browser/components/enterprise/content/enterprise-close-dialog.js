/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
const gArgs = window.arguments[0].wrappedJSObject ?? window.arguments[0];

/**
 * Initializes the enterprise close dialog, called on DOMContentLoaded.
 */
function onLoad() {
  document.title = gArgs.title;
  document.getElementById("infoTitle").textContent = gArgs.title;
  document.getElementById("infoBody").textContent = gArgs.message;

  if (gArgs.reauthNotice) {
    const reauthEl = document.getElementById("infoReauth");
    reauthEl.textContent = gArgs.reauthNotice;
    reauthEl.removeAttribute("hidden");
  }

  const dialog = document.getElementById("enterpriseCloseDialog");
  dialog.getButton("accept").label = gArgs.acceptLabel;

  if (gArgs.checkboxes.length) {
    createCheckboxes(gArgs.checkboxes);
  }

  document.addEventListener("dialogaccept", onAccept, {
    once: true,
  });
  document.addEventListener("dialogcancel", onCancel, {
    once: true,
  });

  window.sizeToContent();
}

/**
 * Dynamically creates checkboxes in the enterprise close dialog based on provided configurations.
 *
 * @param {Array<{id: string, label: string, checked: boolean}>} checkboxes - An array of checkbox configurations, each containing an id, label, and checked state.
 */
function createCheckboxes(checkboxes) {
  const list = document.getElementById("checkboxesList");
  for (const { id, label, checked } of checkboxes) {
    const checkbox = document.createElementNS(XUL_NS, "checkbox");
    checkbox.id = id;
    checkbox.setAttribute("label", label);
    if (checked) {
      checkbox.setAttribute("checked", "true");
    }
    list.appendChild(checkbox);
  }
  document.getElementById("checkboxesRow").removeAttribute("hidden");
}

/**
 * Handles the accept action for the enterprise close dialog.
 */
function onAccept() {
  gArgs.accepted = true;
  for (const checkboxArgs of gArgs.checkboxes) {
    checkboxArgs.checked = document.getElementById(checkboxArgs.id).checked;
  }
}

/**
 * Handles the cancel action for the enterprise close dialog.
 */
function onCancel() {
  gArgs.accepted = false;
}

document.addEventListener("DOMContentLoaded", onLoad);
