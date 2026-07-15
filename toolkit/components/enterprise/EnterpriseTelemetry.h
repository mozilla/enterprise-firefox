/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_EnterpriseTelemetry_h
#define mozilla_EnterpriseTelemetry_h

#ifdef MOZ_ENTERPRISE

#  include "nsStringFwd.h"

class nsIURI;

// Shared building blocks for enterprise security telemetry, so that the
// enabled-check, URL redaction and (throttled) ping submission cannot drift
// between events. A recording site composes them around its own event-specific
// work: check EventReportingEnabled, build the event's Extra with `url` set from
// RedactUrl, Record it, then MaybeSubmitEnterprisePing.
namespace mozilla::enterprise {

// Whether enterprise security telemetry is enabled for the event whose prefs
// live under aPrefPrefix. Reads "<aPrefPrefix>.enabled" (default true).
bool EventReportingEnabled(const nsACString& aPrefPrefix);

// Redacts aURI according to the "<aPrefPrefix>.urlLogging" policy: "full"
// (the default) yields the full spec, "domain" the host only, and "none"
// nothing. aResult is cleared and left empty for the "none" policy, a null
// aURI, or a URI retrieval failure.
void RedactUrl(const nsACString& aPrefPrefix, nsIURI* aURI,
               nsACString& aResult);

// Submits the enterprise ping, throttled so a burst of events (for example the
// many Safe Browsing hits produced by a single page load) does not result in
// one ping per event. A no-op while the shared
// "browser.safebrowsing.enterprise.telemetry.testing.disableSubmit" pref is
// set. Must be called on the main thread of the parent process.
void MaybeSubmitEnterprisePing();

}  // namespace mozilla::enterprise

#endif  // MOZ_ENTERPRISE
#endif  // mozilla_EnterpriseTelemetry_h
