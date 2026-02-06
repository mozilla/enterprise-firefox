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

unauthenticated-vpn-title =Try { -brand-product-name }’s built-in VPN
unauthenticated-hide-location-message = Hide your location and add extra encryption to your browsing inside { -brand-product-name }.
unauthenticated-bandwidth-limit-message = Get 150 GB of free VPN data every month.
unauthenticated-get-started = Get started

site-exclusion-toggle-label = Use VPN for this site
site-exclusion-toggle-enabled =
  .aria-label = VPN is on for this site
site-exclusion-toggle-disabled =
  .aria-label = VPN is off for this site

ipprotection-settings-link =
  .label = Settings

## Status card

ipprotection-connection-status-connected = VPN is on
ipprotection-connection-status-disconnected = VPN is off
ipprotection-connection-status-excluded = VPN is off for this site
ipprotection-connection-status-connecting = VPN is connecting…

# Button to turn off the VPN
ipprotection-button-turn-vpn-off = Turn off VPN
# Button to turn off the VPN when the VPN panel is open while viewing
# a page from an excluded site.
ipprotection-button-turn-vpn-off-excluded-site = Turn off VPN everywhere
# Button to turn on the VPN
ipprotection-button-turn-vpn-on = Turn on VPN
# Button while VPN is connecting
ipprotection-button-connecting = Turning on…

## VPN paused state

ipprotection-connection-status-paused-title = VPN paused
# Variables
#   $maxUsage (number) - The maximum amount of data a user can use in a month (in GB)
ipprotection-connection-status-paused-description = You’ve used all { $maxUsage } GB of your VPN data. Access will reset next month.
upgrade-vpn-title = Get extra protection beyond the browser
upgrade-vpn-description = Choose your VPN location, use VPN for all of your apps and up to 5 devices, and stay secure on any network — at home or on public Wi-Fi.
upgrade-vpn-button = Try { -mozilla-vpn-brand-name }

## Messages and errors

ipprotection-message-generic-error =
  .heading = Couldn’t connect to VPN
  .message = Try again in a few minutes.

# Variables
#   $usageLeft (number) - The amount of data a user has left in a month (in GB)
#   $maxUsage (number) - The maximum amount of data a user can use in a month (in GB)
ipprotection-message-bandwidth-warning =
  .heading = You’re almost at your bandwidth limit
  .message = You have { $usageLeft } GB of { $maxUsage } GB left this month.

ipprotection-message-continuous-onboarding-intro = Turn on VPN to hide your location and add extra encryption to your browsing.
ipprotection-message-continuous-onboarding-autostart = <a data-l10n-name="setting-link">Set VPN to turn on</a> every time you open { -brand-short-name } for an extra layer of protection.
ipprotection-message-continuous-onboarding-site-settings = { -brand-short-name } will remember which websites you’ve set to use VPN. Update these in <a data-l10n-name="setting-link">settings</a> anytime.

confirmation-hint-ipprotection-navigated-to-excluded-site = VPN is off for this site

## IP Protection Settings

ip-protection-description =
  .label = VPN
  .description = Hides your location and adds extra encryption to your browsing in { -brand-short-name }.
ip-protection-learn-more = Learn more

ip-protection-site-exceptions =
  .label = Site specific settings

# Variables:
#   $maxUsage (number) - The bandwidth limit of free VPN, in GB
ip-protection-not-opted-in =
  .heading = Try { -brand-short-name }’s built-in VPN
  .message = Hide your location and add extra encryption to your browsing in { -brand-short-name }. Get { $maxUsage } GB of free VPN data every month.
ip-protection-not-opted-in-button = Get started

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

## IP Proctection Bandwidth

ip-protection-bandwidth-header = Monthly VPN data

## Variables
##   $usageLeft (number) - The amount of data a user has left in a month (in GB)
##   $maxUsage (number) - The maximum amount of data a user can use in a month (in GB)

ip-protection-bandwidth-left-this-month-gb = { $usageLeft } GB of { $maxUsage } GB left this month
ip-protection-bandwidth-left-gb = { $usageLeft } GB of { $maxUsage } GB left

## Variables
##   $usageLeft (number) - The amount of data a user has left in a month (in MB)
##   $maxUsage (number) - The maximum amount of data a user can use in a month (in GB)

ip-protection-bandwidth-left-this-month-mb = { $usageLeft } MB of { $maxUsage } GB left this month
ip-protection-bandwidth-left-mb = { $usageLeft } MB of { $maxUsage } GB left

## Variables
##   $maxUsage (number) - The maximum amount of data a user can use in a month (in GB)

ip-protection-bandwidth-hit-for-the-month = You’ve used all { $maxUsage } GB of your VPN data. Access will reset next month.
ip-protection-bandwidth-help-text = Resets to { $maxUsage } GB on the first of every month.

## IP Protection alerts

vpn-paused-alert-title = VPN paused

# Variables
#   $maxUsage (number) - The maximum amount of data a user can use in a month (in GB)
vpn-paused-alert-body = You’ve used all { $maxUsage } GB of your VPN data. VPN access will reset next month.

vpn-paused-alert-close-tabs-button = Close all tabs
vpn-paused-alert-continue-wo-vpn-button = Continue without VPN

vpn-error-alert-title = VPN isn’t working right now.
vpn-error-alert-body = Try again later.

##
