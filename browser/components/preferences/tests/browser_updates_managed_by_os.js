/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_task(async function test_updates_managed_by_os_message_bar() {
  await openPreferencesViaOpenPreferencesAPI("general", { leaveOpen: true });
  let doc = gBrowser.selectedBrowser.contentDocument;
  let win = gBrowser.selectedBrowser.contentWindow;

  let settingControl = doc.getElementById("updatesManagedByOS");
  await settingControl.updateComplete;

  let isPackagedApp = Services.sysinfo.getProperty("isPackagedApp");
  is(
    BrowserTestUtils.isHidden(settingControl),
    win.AppConstants.MOZ_UPDATER && !isPackagedApp,
    "updatesManagedByOS message bar is shown only when running as a packaged app"
  );

  gBrowser.removeCurrentTab();
});
