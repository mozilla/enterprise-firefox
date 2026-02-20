/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { Utils } = ChromeUtils.importESModule(
  "resource://services-settings/Utils.sys.mjs"
);

function clear_state() {
  Services.prefs.clearUserPref("services.settings.server");
}

add_setup(async function () {
  registerCleanupFunction(() => {
    clear_state();
  });
});

add_task(
  {
    skip_if: () => !AppConstants.MOZ_ENTERPRISE,
  },
  async function test_server_url_from_pref() {
    Services.prefs.setStringPref(
      "services.settings.server",
      "https://custom-rs.example.com/v1"
    );

    Assert.equal(
      Utils.SERVER_URL,
      "https://custom-rs.example.com/v1",
      "SERVER_URL should be read from the services.settings.server pref"
    );
  }
);
add_task(clear_state);
