# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# Access Connector is an Enterprise feature name and must not be translated.
-enterprise-feature-access-connector = Access Connector

enterprise-toolbar-button =
    .label = { -brand-short-name }
    .tooltiptext = { -brand-short-name }

enterprise-panel =
    .label = { -brand-short-name } panel
    .tooltiptext = { -brand-short-name } panel
enterprise-panel-alert = Some Activity Is Monitored
enterprise-panel-information = You’re signed into a company-managed browser. Certain browsing activity may be monitored by your company for security and compliance.
enterprise-panel-learn-more = Learn more
enterprise-panel-sign-out-btn =
    .label = Sign out…

enterprise-close-prompt-title = Close { -brand-short-name }?

# Variables:
#   $tabCount (Number): The number of tabs to be closed.
enterprise-close-prompt-title-with-tabcount-and-signout-warning =
    { $tabCount ->
        [one] Close { -brand-short-name } and { $tabCount } tab?
       *[other] Close { -brand-short-name } and { $tabCount } tabs?
    }

# Variables:
#   $tabCount (Number): The number of tabs to be closed.
enterprise-close-prompt-title-with-tabcount =
    { $tabCount ->
        [one] Close { $tabCount } tab?
       *[other] Close { $tabCount } tabs?
    }

enterprise-close-prompt-message = You’re about to sign out of { -brand-short-name } and end your session.

# Variables:
#   $tabCount (Number): The number of tabs to be closed.
enterprise-close-prompt-message-with-tabcount-and-signout-warning =
    { $tabCount ->
        [one] You’re about to sign out of { -brand-short-name } and close { $tabCount } tab.
       *[other] You’re about to sign out of { -brand-short-name } and close { $tabCount } tabs.
    }

enterprise-close-prompt-message-with-tabcount = Closing { -brand-short-name } will also sign you out.
enterprise-close-prompt-message-reauth = To use { -brand-short-name } again, you’ll need to reauthenticate through your organization’s SSO provider.
enterprise-close-prompt-checkbox-label = Warn me when closing { -brand-short-name } signs me out
enterprise-close-prompt-tabs-checkbox-label = Warn me when closing multiple tabs
enterprise-close-prompt-primary-btn-label = Close and sign out

enterprise-quit-shortcut-prompt-title-with-tabs = Quit { -brand-short-name } or close current tab?
enterprise-quit-shortcut-prompt-title = Close window and quit { -brand-short-name }?
enterprise-quit-shortcut-prompt-message = Quitting will sign you out of your session. You’ll need to reauthenticate through your organization’s SSO provider.
enterprise-quit-shortcut-prompt-primary-btn-label = Quit and sign out

restart-forced-title = Restart { -brand-short-name }
restart-forced-heading = Restart to continue using { -brand-short-name }.
restart-forced-intro = Company policy requires that { -brand-short-name } be restarted.
window-restoration-info = Your windows and tabs will be quickly restored, except private ones.

restart-button-label = Restart { -brand-short-name }

extension-firefox-enterprise-light-name = Firefox Enterprise Light
extension-firefox-enterprise-light-description = A soft pastel theme with a touch of morning sunlight in the corner.

extension-firefox-enterprise-dark-name = Firefox Enterprise Dark
extension-firefox-enterprise-dark-description = A deep midnight theme with dark petrol blues and subtle, lighter blue gradients.

lockdown-mode-button =
    .aria-label = Viewing with restrictions
    .tooltiptext = Viewing with restrictions
lockdown-mode-popup-header = Viewing with restrictions applied
lockdown-mode-popup-message = You’re viewing this page with extra security protections applied by your organization. Some features may be limited to help reduce security risks.

blocked-by-policy-title-enterprise = Access to this site is restricted
neterror-blocked-by-policy-page-title-enterprise = Access to this site is restricted
neterror-blocked-by-policy-contact-admin = If you believe this is an error or need access for work purposes, please contact your IT administrator.

enterprise-access-connector-heading2 = { -enterprise-feature-access-connector }
enterprise-access-connector-info-active = This site is being accessed through a secure company connection.
enterprise-access-connector-button2 =
  .label = { -enterprise-feature-access-connector }
  .tooltiptext = { -enterprise-feature-access-connector }
enterprise-access-connector-status-label-active = active
enterprise-access-connector-status-label-inactive = inactive

crashed-policy-auto-submit-title = Crash reports help us improve
crashed-policy-auto-submit-message = Your administrator has configured { -brand-short-name } to send crash reports automatically.

fp-neterror-access-connector-error-title = This website can’t be reached
fp-neterror-access-connector-error-description = Your organization routes this website through a secure connection service, but that service is currently unavailable.
fp-neterror-access-connector-error-contact-admin = Try again later, or contact your administrator if you need access.
