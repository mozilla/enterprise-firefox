# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

## Toolbar button tooltip reflects VPN state

ipprotection-button =
  .label = VPN
  .tooltiptext = VPN

ipprotection-button-error =
  .label = Turn VPN on
  .tooltiptext = Turn VPN on

##

# The word "Beta" is intended to be uppercase in the experiment label.
ipprotection-experiment-badge =
  .label = BETA

ipprotection-help-button =
  .tooltiptext = Open VPN support page

ipprotection-title = VPN

## Feature introduction callout

ipprotection-feature-introduction-title = Free VPN, right inside your browser
ipprotection-feature-introduction-link-text = You’ve been selected for early access to our new, <a data-l10n-name="learn-more-vpn">built-in VPN</a>. Hide your location and add extra encryption to your browsing in { -brand-product-name }. Sign in to get started.
ipprotection-feature-introduction-button-primary = Next
ipprotection-feature-introduction-button-secondary-not-now = Not now
ipprotection-feature-introduction-button-secondary-no-thanks = No thanks

## Panel

signed-out-vpn-title = Sign in to boost your browser’s privacy with free VPN
signed-out-vpn-message = You’ve been selected for early access to our new, <a data-l10n-name="learn-more-vpn-signed-out">built-in VPN</a>. Enhance your browser’s protection by hiding your location and encrypting your traffic.
sign-in-vpn = Next

site-exclusion-toggle-label = Use VPN for this site
site-exclusion-toggle-enabled =
  .aria-label = VPN is on for this site
site-exclusion-toggle-disabled =
  .aria-label = VPN is off for this site

## Status card

ipprotection-connection-status-on =
  .label = VPN is on
ipprotection-connection-status-off =
  .label = VPN is off

# The panel status card has a header, as well as VPN server location name displayed under it when the VPN is on.
# Location refers to the VPN server geographical position.
ipprotection-location-title =
  .title = Location selected based on fastest server

# When VPN is toggled on
ipprotection-toggle-active =
  .aria-label = Turn VPN off
# When VPN is toggled off
ipprotection-toggle-inactive =
  .aria-label = Turn VPN on

# Button to turn off the VPN
ipprotection-button-turn-vpn-off = Turn off VPN
# Button to turn on the VPN
ipprotection-button-turn-vpn-on = Turn on VPN

## VPN paused state

ipprotection-connection-status-paused-title = VPN paused
ipprotection-connection-status-paused-description = You’ve used all 150 GB of your VPN data. Access will reset next month.
upgrade-vpn-title = Get extra protection beyond the browser
upgrade-vpn-description = Choose your VPN location, use VPN for all of your apps and up to 5 devices, and stay secure on any network — at home or on public Wi-Fi.
upgrade-vpn-button = Try { -mozilla-vpn-brand-name }

## Messages and errors

ipprotection-message-generic-error =
  .heading = Couldn’t connect to VPN
  .message = Try again in a few minutes.

ipprotection-message-bandwidth-warning =
  .heading = You’re almost at your bandwidth limit
  .message = You have 1 GB of the allocated 150 GB left this month.

ipprotection-message-continuous-onboarding-intro = Turn on VPN to hide your location and add extra encryption to your browsing.
ipprotection-message-continuous-onboarding-autostart = <a data-l10n-name="setting-link">Set VPN to turn on</a> every time you open { -brand-short-name } for an extra layer of protection.
ipprotection-message-continuous-onboarding-site-settings = { -brand-short-name } will remember which websites you’ve set to use VPN. Update these in <a data-l10n-name="setting-link">settings</a> anytime.

## IP Protection Settings

ip-protection-description =
  .label = VPN
  .description = Hides your location and adds extra encryption to your browsing in { -brand-short-name }.
ip-protection-learn-more = Learn more

ip-protection-site-exceptions =
  .label = Site specific settings

# Variables:
#   $count (number) - The number of sites saved as VPN exclusions.
ip-protection-site-exceptions-all-sites-button =
  .label = Manage website settings
  .description =
    { $count ->
        [one] { $count } website
       *[other] { $count } websites
    }

ip-protection-autostart =
  .label = Turn on VPN automatically
ip-protection-autostart-checkbox =
  .label = When I open { -brand-short-name }
ip-protection-autostart-private-checkbox =
  .label = In private windows

ip-protection-vpn-upgrade-link =
  .label = Get even more protection outside { -brand-short-name } with { -mozilla-vpn-brand-name }
  .description = Choose custom VPN locations and add protection to all your apps on up to five devices, whether you’re at home or on public Wi-Fi.

## IP Protection dialogs

ip-protection-exceptions-dialog-window =
  .title = Where to use VPN
ip-protection-exclusions-desc = Use VPN for all websites except ones on this list. Add websites to this list by turning VPN on or off for any site in the VPN panel.

ipprotection-site-settings-title =
  .title = VPN site settings

##
