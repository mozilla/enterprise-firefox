/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* global pref */

pref("enterprise.console.address", "https://fx-ent-console.zomilla.org");
pref("enterprise.locking.enabled", true);

pref("browser.profiles.enabled", false);
pref("extensions.activeThemeID", "firefox-enterprise-light@mozilla.org");

pref("enterprise.loglevel", "Error");

pref("browser.newtabpage.activity-stream.feeds.section.topstories", false);

// On Enterprise we want to enforce updates so we force it
// Bug 2020768: Should those value be set/locked at runtime by FELT only
//              or is it fine to apply it to any enterprise build?
pref("app.update.auto", true);
pref("app.update.checkOnlyInstance.enabled", false);
pref("app.update.background.enabled", true);
pref("app.update.staging.enabled", true);
