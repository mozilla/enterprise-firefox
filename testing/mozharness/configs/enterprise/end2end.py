# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.


#####
config = {
    "owner": "mozilla",
    "repo": "enterprise-console",
    "secret_files": [
        {
            "filename": "enterprise-console-backend-apitoken",
            "secret_name": "project/enterprise/level-%(scm-level)s/enterprise-console-backend-apitoken",
            "min_scm_level": 1,
            "mode": 0o600,
        },
    ],
}
