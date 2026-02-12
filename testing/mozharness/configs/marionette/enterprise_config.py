# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# This is a template config file for marionette production.
config = {
    "test_manifest": "../../../../enterprise/manifest.toml",
    "suite_definitions": {
        "marionette_desktop": {
            "options": [
                "-vv",
                "--log-errorsummary=%(error_summary_file)s",
                "--log-html=%(html_report_file)s",
                "--binary=%(binary)s",
                "--address=%(address)s",
                "--symbols-path=%(symbols_path)s",
            ],
            "run_filename": "",
            "testsdir": "marionette",
        },
    },
}
