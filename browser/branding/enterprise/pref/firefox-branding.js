/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// This file contains branding-specific prefs.

pref("startup.homepage_override_url", "");
pref("startup.homepage_welcome_url", "about:welcome");
pref("startup.homepage_welcome_url.additional", "");
// Interval: Time between checks for a new version (in seconds)
pref("app.update.interval", 21600); // 6 hours
// Give the user x seconds to react before showing the big UI. default=192 hours
pref("app.update.promptWaitTime", 691200);
// We don't have a page for manual updates yet (Bug 2073413), so default to the support page.
pref("app.update.url.manual", "https://support.mozilla.org/en-US/products/firefox-enterprise");
pref("app.update.url.details", "https://www.firefox.com/%LOCALE%/firefox/enterprise/%VERSION%/releasenotes/");
pref("app.releaseNotesURL", "https://www.firefox.com/%LOCALE%/firefox/enterprise/%VERSION%/releasenotes/?utm_source=firefox-browser&utm_medium=firefox-desktop&utm_campaign=whatsnew");
pref("app.releaseNotesURL.aboutDialog", "https://www.firefox.com/%LOCALE%/firefox/enterprise/%VERSION%/releasenotes/?utm_source=firefox-browser&utm_medium=firefox-desktop&utm_campaign=about-dialog");
pref("app.releaseNotesURL.prompt", "https://www.firefox.com/%LOCALE%/firefox/enterprise/%VERSION%/releasenotes/?utm_source=firefox-browser&utm_medium=firefox-desktop&utm_campaign=updateprompt");

// The number of days a binary is permitted to be old
// without checking for an update.  This assumes that
// app.update.checkInstallTime is true.
pref("app.update.checkInstallTime.days", 63);

// Give the user x seconds to reboot before showing a badge on the hamburger
// button. default=4 days
pref("app.update.badgeWaitTime", 345600);

// Number of usages of the web console.
// If this is less than 5, then pasting code into the web console is disabled
pref("devtools.selfxss.count", 0);

// Default enterprise theme
pref("extensions.activeThemeID", "firefox-enterprise-auto@mozilla.org");