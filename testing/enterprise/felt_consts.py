#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

firefox_config = {
    "learn_more_url": {
        "pref_id": "enterprise.configs.learn_more_url",
        "pref_value": "http://localhost:0/learnmore",
    },
    "company_logo_url": {
        "pref_id": "enterprise.configs.company_logo_url",
        "pref_value": "",
    },
    "polling_frequency": {
        "pref_id": "enterprise.policies.live.polling_interval",
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
