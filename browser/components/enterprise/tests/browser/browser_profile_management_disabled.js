/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Profile management is disabled on Firefox Enterprise.

const BLOCKED_URLS = [
  "about:profiles",
  "about:pRofiles",
  "chrome://global/content/aboutProfiles.xhtml",
  "chrome://browser/content/profiles/profiles.html",
  "chrome://browser/content/profiles/new-profile.html",
  "chrome://browser/content/profiles/edit-profile.html",
  "chrome://browser/content/profiles/delete-profile.html",
];

const UNAVAILABLE_URLS = [
  "about:profilemanager",
  "about:newprofile",
  "about:editprofile",
  "about:deleteprofile",
];

add_task(function test_profiles_pref_is_locked_off() {
  const pref = "browser.profiles.enabled";
  Assert.ok(Services.prefs.prefIsLocked(pref), `${pref} is locked`);
  Assert.ok(!Services.prefs.getBoolPref(pref), `${pref} is disabled`);
});

add_task(async function test_profile_pages_are_blocked() {
  for (const url of BLOCKED_URLS) {
    await BrowserTestUtils.withNewTab(
      { gBrowser, url: "about:blank" },
      async browser => {
        BrowserTestUtils.startLoadingURIString(browser, url);
        await BrowserTestUtils.browserLoaded(browser, false, url, true);
        await SpecialPowers.spawn(browser, [url], async function (aUrl) {
          Assert.ok(
            content.document.documentURI.startsWith(
              "about:neterror?e=blockedByPolicy"
            ),
            `${aUrl} is blocked`
          );
        });
      }
    );
  }
});

add_task(function test_selectable_profile_pages_are_unavailable() {
  for (const url of UNAVAILABLE_URLS) {
    Assert.throws(
      () =>
        NetUtil.newChannel({
          uri: Services.io.newURI(url),
          loadUsingSystemPrincipal: true,
        }),
      /NS_ERROR_NOT_AVAILABLE/,
      `${url} is unavailable`
    );
  }
});
