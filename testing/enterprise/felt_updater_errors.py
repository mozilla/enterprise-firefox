#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

import requests

sys.path.append(os.path.dirname(__file__))

from felt_tests import FeltTests


class FeltUpdaterErrorsBase(FeltTests):
    def get_update_config_file_path(self):
        self._driver.set_context("chrome")
        rv = self._driver.execute_script(
            """
            const { UpdateUtils } = ChromeUtils.importESModule("resource://gre/modules/UpdateUtils.sys.mjs");
            return UpdateUtils.getConfigFilePath();
            """
        )
        self._driver.set_context("content")
        return rv

    def reload_chrome_window(self):
        self._driver.set_context("chrome")
        self._driver.execute_async_script(
            """
            const callback = arguments[arguments.length - 1];
            const UM = Cc["@mozilla.org/updates/update-manager;1"].getService(Ci.nsIUpdateManager);
            UM.internal.reload(false).then(() => {
              const { Updates } = ChromeUtils.importESModule("resource:///modules/enterprise/Updates.sys.mjs");
              Updates.uninit();
              window.location.reload();
            }).finally(() => callback());
            """
        )
        self._driver.set_context("content")

    def get_updates_served(self):
        return requests.get(
            f"http://localhost:{self.console_port}/api/browser/forced_updates_count"
        ).json()["serve_forced_updates_count"]

    def assert_updates_served(self, amount):
        served = self.get_updates_served()
        self._logger.info(f"Checking updates served: {amount} vs {served}")
        self._wait.until(lambda mn: self.get_updates_served() == amount)
        served = self.get_updates_served()
        assert served == amount, (
            f"There should have been {amount} update served but {served}"
        )

    def assert_updates_check_allowed(self, allowed):
        self._driver.set_context("chrome")
        rv = self._driver.execute_async_script(
            """
            const callback = arguments[arguments.length - 1];
            const UM = Cc["@mozilla.org/updates/update-manager;1"].getService(Ci.nsIUpdateManager);
            UM.internal.reload(false).then(() => {
              const { Updates } = ChromeUtils.importESModule("resource:///modules/enterprise/Updates.sys.mjs");
              Updates.updateCheckingAllowed().then(() => callback(Updates._canDoUpdateChecking));
            });
            """
        )
        self._driver.set_context("content")
        print(f"assert_updates_check_allowed: {rv}")
        assert rv == allowed, f"Update checks are {rv} but expected {allowed}"

    def assert_error_displayed(self):
        self._driver.set_context("chrome")

        browser_error = self.get_elem(".felt-browser-error")
        assert browser_error, "Error dialog present"

        error_details = self.get_elem(
            ".felt-updates-error-messages .felt-browser-error-details"
        )
        error_msg = error_details.text

        self._driver.set_context("content")

        assert error_msg == "Please contact your administrator.", (
            "Should display a contact your administrator error message"
        )

    def reset_updates_served(self):
        self._logger.info("Reset updates served")
        requests.post(
            f"http://localhost:{self.console_port}/api/browser/forced_updates_count"
        )

    def one_xml(self, state):
        return f"""
<update xmlns="http://www.mozilla.org/2005/app-update" appVersion="2000.0a1" buildID="22221010555555" channel="default" detailsURL="https://www.mozilla.org/en-US/firefox/notes" displayVersion="2000.0a1" platformVersion="2000.0a1" installDate="1773852795836" isCompleteUpdate="true" name="Firefox Enterprise 2000.0a1" previousAppVersion="150.0a1" promptWaitTime="691200" serviceURL="http://localhost:8000/api/browser/updates/FirefoxEnterprise/150.0a1/20260317000000/Darwin_aarch64-gcc3/en-US/default/Darwin%252025.3.0/ISET%3ANEON%2CMEM%3A24576/default/default/update.xml?force=1" type="major" statusText="Install Pending" foregroundDownload="true">
  <patch size="83136062" type="complete" URL="http://localhost:8000/firefox-150.0a1.en-US.mac.complete.mar" errorCode="9" finalURL="http://localhost:8000/firefox-150.0a1.en-US.mac.complete.mar?backgroundTaskMode=0" selected="true" state="{state}" internalResult="0" numTotalInstallAttempts="1"/>
</update>
"""

    def write_updates_xml(self, updates=None):
        self._logger.info(
            f"Writing {len(updates)} updates failures in {self._updates_history}"
        )

        with open(self._updates_history, "w") as output_xml:
            output_xml.write(f"""<?xml version="1.0"?>
<updates xmlns="http://www.mozilla.org/2005/app-update">
  {"".join(updates)}
</updates>""")
