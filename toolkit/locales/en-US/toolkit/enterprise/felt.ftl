# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

### FELT (Firefox Enterprise Launcher Tool) SSO Login

felt-window-title = { -brand-short-name } — Login

felt-sso-title = Sign in
felt-sso-input-email =
    .description = Use your organizational-issued email
    .label = Work email
felt-sso-continue-btn =
    .label = Continue

felt-pending-action-notification = Please wait while { -brand-short-name } starts…
felt-powered-by =
    Powered by { -vendor-short-name }

# Example of resulting string: 151.0a1 (2026-04-01)
# Variables:
#   $version (String): version of Firefox for Nightly builds, e.g. 151.0a1
#   $isodate (String): date in ISO format, e.g. 2026-04-01
felt-version-nightly = { $version } ({ $isodate })

# Example of resulting string: 151.0b1 (e.g. for beta builds) or 151.0. (e.g. for release build)
# Variables:
#   $version (String): version of Firefox for beta and release builds
felt-version = { $version }

# Copy of urlbar-web-authn-anchor: Felt relies on the WebAuthn prompter and its
# mechanisms uses this string even if not visible in our UI. This is the only
# string requiring pulling browser/browser.ftl, so make a copy here and use it
# in our felt.xhtml
felt-urlbar-web-authn-anchor =
    .tooltiptext = Open Web Authentication panel

## Error details when launching the browser crashes

felt-browser-error-sso-timeout2 =
    .heading = Sign-in timed out
    .message = Please try again, or contact your administrator if the problem persists.
felt-browser-error-token-refresh-failed =
    .heading = You’ve been signed out
    .message = Please sign in again, or contact your administrator if you have any questions.
felt-browser-error-multiple-crashes2 =
    .heading = { -brand-short-name } crashed multiple times
felt-browser-error-launch-failure =
    .heading = { -brand-short-name } cannot start
    .message = Please contact your administrator if the problem persists.
felt-error-primary-secret =
    .heading = { -brand-short-name } cannot start securely
    .message = Your secure profile key could not be retrieved. Please try again, or contact your administrator if the problem persists.

## Logout messages

felt-browser-info-console-forced-logout =
    .heading = You’ve been signed out
    .message = An administrator signed you out as part of routine account management. If you have any questions, please contact your administrator directly.

## Network error headings

felt-browser-error-connection2 =
    .heading = Unable to connect. Please contact your administrator.
felt-browser-error-no-network =
    .heading = No network connection

## Network error details.

felt-error-network = Unknown network error
felt-error-no-network-connection = Please check your internet connection and try again.
felt-error-neterror-dns-not-found-title = Server not found

## Updates messages and related errors messages

felt-updates-title = Good morning
felt-updates-checking = Checking for updates…
felt-updates-application = Applying updates…
felt-updates-uptodate = { -brand-short-name } is up to date
felt-error-updates =
    .heading = An error occurred while applying updates…
felt-error-contact-admin = Please contact your administrator.
felt-warning-unsupported-system-contact-admin =
    .heading = Unsupported operating system
felt-error-warning-unsupported-system-contact-admin = A new version of { -brand-short-name } is available, but your operating system is not supported. Contact your administrator for assistance.
felt-error-checking-failed-contact-admin = Unexpected failure while checking for an update. Please contact your administrator.
felt-warning-title-elevation-attempt-failed =
    .heading = Update couldn’t be installed
felt-error-warning-elevation-attempt-failed-contact-admin = An update couldn’t be installed due to insufficient system privileges. Please contact your administrator for help.
felt-warning-title-download-attempt-failed =
    .heading = Update couldn’t be downloaded
felt-error-warning-download-attempt-failed-contact-admin = The latest update couldn’t be downloaded. If this problem persists, contact your administrator for help.
