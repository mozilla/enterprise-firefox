#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys
import time

sys.path.append(os.path.dirname(__file__))

from felt_consts import firefox_config
from felt_tests import FeltTests
from marionette_driver import errors


class BrowserWatermark(FeltTests):
    def test_browser_watermark(self):
        self.run_felt_base()
        self.connect_child_browser()

        self._logger.info("Enabling the Watermark policy")
        self.enable_watermark_policy()

        self._logger.info("Loading a page matched by the Watermark policy")
        self.open_tab_child(f"http://localhost:{self.sso_port}/sso_url")

        self.assert_watermark_drawn_in_browser()

    def test_browser_watermark_screenshot(self):
        self.run_felt_base()
        self.connect_child_browser()

        blank_url = f"http://localhost:{self.sso_port}/watermark_blank_page"

        self._logger.info("Screenshotting the blank page before the watermark")
        self.open_tab_child(blank_url)
        self._child_driver.set_context("content")
        blank_hash = self._child_driver.screenshot(format="hash")

        self._logger.info("Enabling the Watermark policy")
        self.enable_watermark_policy()

        # The on-screen watermark is painted from anonymous content and can't be
        # found in the DOM, so instead assert the rendered page no longer matches
        # the blank baseline. The config is fetched asynchronously, so retry.
        def watermark_painted(driver):
            return driver.screenshot(format="hash") != blank_hash

        try:
            self._child_longwait.until(watermark_painted)
        except errors.TimeoutException:
            raise AssertionError(
                "Expected the watermark to change the rendering of a blank page"
            )

    def enable_watermark_policy(self):
        self.policy_watermark.value = 1

        # Polling frequency + 1s, to give the policy time to be applied.
        waiting_time = (firefox_config["polling_frequency"]["pref_value"] / 1000) + 1
        time.sleep(waiting_time)
        self._logger.info(
            f"Watermark policy should have been applied after waiting {waiting_time}s"
        )

    def assert_watermark_drawn_in_browser(self):
        self._logger.info("Checking the watermark is drawn in the browser")

        self._child_driver.set_context("content")

        def watermark_drawn(driver):
            return driver.execute_script(
                """
                function findWatermark(node) {
                    if (node.nodeType === 1 && node.id === "enterprise-watermark") {
                        return node;
                    }

                    for (let child of InspectorUtils.getChildrenForNode(node, true, false)) {
                        let found = findWatermark(child);
                        if (found) {
                            return found;
                        }
                    }

                    return null;
                }

                return !!findWatermark(document)?.querySelector("svg pattern");
                """,
                sandbox="system",
            )

        try:
            self._child_longwait.until(watermark_drawn)
        except errors.TimeoutException:
            raise AssertionError(
                "Expected the enterprise watermark to be drawn on a matching page"
            )
