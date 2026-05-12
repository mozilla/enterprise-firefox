/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const check = () => {
  for (const candidate of document.querySelectorAll(".ant-alert-banner")) {
    if (candidate.innerText.includes("chrome")) {
      candidate.remove();
    }
  }
};

const disconnect = () => {
  try {
    setTimeout(() => observer.disconnect(), 5000);
  } catch (_) {
    observer.disconnect();
  }
};

const observer = new MutationObserver(check);
observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
});

check();

if (document.readyState != "complete") {
  window.addEventListener("load", disconnect, { once: true });
} else {
  disconnect();
}
