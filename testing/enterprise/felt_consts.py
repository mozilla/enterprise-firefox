#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

WHOAMI_EMAIL = "nobody@mozilla.org"

# Values the mock console serves from /api/browser/config. Entries with a
# pref_id are applied by the browser as locked default prefs.
firefox_config = {
    "learn_more_url": {
        # Non-ASCII, so the configuration's UTF-8 round trip through Felt is tested.
        "pref_value": "http://localhost:0/découvrir-plus",
    },
    "company_logo_url": {
        "pref_value": "",
    },
    "polling_frequency": {
        "pref_value": 500,
    },
    "tokenserver_url": {
        "pref_id": "identity.sync.tokenserver.uri",
        "pref_value": "http://localhost:0/tokenserver",
    },
    "push_url": {
        "pref_id": "dom.push.serverURL",
        "pref_value": "wss://localhost:0/push",
    },
    "remote_settings_url": {
        "pref_id": "services.settings.server",
        # The value marionette sets, so Remote Settings stays off the network.
        "pref_value": "data:,#remote-settings-dummy/v1",
    },
}
