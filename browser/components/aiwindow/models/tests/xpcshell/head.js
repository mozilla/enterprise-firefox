/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Any shared setup for these tests lives here. */
const { SecurityProperties } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/SecurityProperties.sys.mjs"
);

/**
 * Creates a minimal conversation-like object for use in tool tests.
 *
 * @param {object} [options]
 * @param {boolean} [options.privateData] - Pre-set the privateData security flag.
 * @param {boolean} [options.untrustedInput] - Pre-set the untrustedInput security flag.
 * @returns {{ securityProperties: SecurityProperties }}
 */
function makeConversation({
  privateData = false,
  untrustedInput = false,
} = {}) {
  const securityProperties = new SecurityProperties();
  if (privateData) {
    securityProperties.setPrivateData();
  }
  if (untrustedInput) {
    securityProperties.setUntrustedInput();
  }
  securityProperties.commit();
  return {
    securityProperties,
    addSeenUrls() {},
    getAllMentionURLs() {
      return new Set();
    },
  };
}
const { PlacesUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/PlacesUtils.sys.mjs"
);
const { PlacesTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/PlacesTestUtils.sys.mjs"
);

add_task(async function setup_profile() {
  do_get_profile(); // ensure a profile dir (needed by Places)
  // Start from a clean history DB
  await PlacesUtils.history.clear();
});
