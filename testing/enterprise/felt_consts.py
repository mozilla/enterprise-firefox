#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

firefox_config = {
    "learn_more_url": {
        "pref_id": "enterprise.configs.learn_more_url",
        "pref_value": "https://localhost:0/learnmore",
    },
    "company_logo_url": {
        "pref_id": "enterprise.configs.company_logo_url",
        "pref_value": "",
    },
    "polling_frequency": {
        "pref_id": "browser.policies.live_polling.frequency",
        "pref_value": 500,
    },
    "tokenserver_url": {
        "pref_id": "identity.sync.tokenserver.uri",
        "pref_value": "",
    },
    "push_url": {
        "pref_id": "dom.push.serverURL",
        "pref_value": "",
    },
    # Not checking remote settings url (services.settings.server),
    # it's pre-populated in marionette test environemtns:
    #  https://searchfox.org/firefox-main/rev/9a3317a65545e83f4e32b94fdf1f6860342423ef/remote/shared/RecommendedPreferences.sys.mjs#381-382
}

import os

https_dir = os.path.join(os.path.dirname(__file__), "https")
ca_pem = os.path.join(https_dir, "ca.pem")
key_pem = os.path.join(https_dir, "localhost.key")
cert_pem = os.path.join(https_dir, "localhost.pem")
