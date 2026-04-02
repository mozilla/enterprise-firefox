#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from felt_tests import FeltTestsBase


class FeltEmailInputFocus(FeltTestsBase):
    """
    Tests the Firefox version in the Felt window
    """

    def teardown(self):
        self._manually_closed_child = True
        super().teardown()

    def test_correct_firefox_version_in_felt_window(self):
        self._driver.set_context("chrome")

        # Get the expected values
        expected = self._driver.execute_script(
            """
            const { AppConstants } = ChromeUtils.importESModule(
            "resource://gre/modules/AppConstants.sys.mjs"
            );

            const version = AppConstants.MOZ_APP_VERSION_DISPLAY;

            if (AppConstants.NIGHTLY_BUILD) {
                const buildID = Services.appinfo.appBuildID;
                const year = buildID.slice(0, 4);
                const month = buildID.slice(4, 6);
                const day = buildID.slice(6, 8);

            return {
                is_nightly: true,
                l10n_id: "felt-version-nightly",
                version,
                isodate: `${year}-${month}-${day}`,
            };
            }

            return {
                l10n_id: "felt-version",
                version,
                isodate: null,
            };
            """
        )

        # Get the actual values
        actual = self._driver.execute_script(
            """
            const versionElement = document.querySelector(".felt-version");
            return document.l10n.getAttributes(versionElement);
            """
        )

        assert actual["id"] == expected["l10n_id"]
        assert actual["args"]["version"] == expected["version"]

        if expected["is_nightly"] is True:
            assert actual["args"]["isodate"] == expected["isodate"]
        else:
            assert "isodate" not in actual["args"]

        self._driver.set_context("content")
