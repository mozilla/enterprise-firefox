# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

### Import Logins Autocomplete

## Variables:
##   $host (String) - Host name of the current site.

autocomplete-import-logins-chrome =
    <div data-l10n-name="line1">Import your login from Google Chrome</div>
    <div data-l10n-name="line2">for { $host } and other sites</div>
autocomplete-import-logins-chromium =
    <div data-l10n-name="line1">Import your login from Chromium</div>
    <div data-l10n-name="line2">for { $host } and other sites</div>
autocomplete-import-logins-chromium-edge =
    <div data-l10n-name="line1">Import your login from Microsoft Edge</div>
    <div data-l10n-name="line2">for { $host } and other sites</div>

##

autocomplete-import-learn-more = Learn more

## Secondary actions shown on form autocomplete dropdown rows.
## Gated by the browser.autocomplete.removeRecords.enabled pref.

# aria-label and tooltip for the button that opens the edit/delete menu.
autocomplete-more-actions = More actions
autocomplete-edit-password = Edit this password
autocomplete-delete-password = Delete this password
autocomplete-edit-address = Edit this address
autocomplete-delete-address = Delete this address
autocomplete-edit-payment-method = Edit this payment method
autocomplete-delete-payment-method = Delete this payment method
# aria-label and tooltip for the trash button on a form history entry.
autocomplete-delete-form-history-entry = Delete this form history entry
