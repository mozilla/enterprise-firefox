/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_EnterpriseTelemetry_h
#define mozilla_EnterpriseTelemetry_h

#include <cstdint>
#include "nsStringFwd.h"

class nsIURI;

// Shared building blocks for enterprise security telemetry, so that the
// enabled-check, URL redaction and (throttled) ping submission cannot drift
// between events. A recording site composes them around its own event-specific
// work: check EventReportingEnabled, ask ThrottleEnterprisePing what to do and
// bail on Drop, build the event's Extra with `url` set from MaybeRedactUrl,
// Record it, then submit the enterprise ping (glean_pings::Enterprise.Submit())
// when ThrottleEnterprisePing returned RecordAndSubmit.
namespace mozilla::enterprise {

// Whether enterprise security telemetry is enabled for the event whose prefs
// live under aPrefPrefix. Reads "<aPrefPrefix>.enabled" (default true).
bool EventReportingEnabled(const nsACString& aPrefPrefix);

// Redacts aURI according to the "<aPrefPrefix>.urlLogging" policy: "full"
// (the default) yields the full spec with any password masked, "domain" the
// host only, and "none" nothing. aProcessedUrl is cleared and left empty for
// the "none" policy, a null aURI, or a URI retrieval failure.
void MaybeRedactUrl(const nsACString& aPrefPrefix, nsIURI* aURI,
                    nsACString& aProcessedUrl);

// How a recording site should handle the next enterprise security event, as
// decided by ThrottleEnterprisePing.
enum class EnterprisePingAction {
  // No cooldown window holds this event back: record it and then submit the
  // enterprise ping (glean_pings::Enterprise.Submit()).
  RecordAndSubmit,
  // Submission is disabled via the testing.disableSubmit pref: still record the
  // event so tests can inspect it, but do not submit a ping.
  RecordOnly,
  // The originating tab already submitted a ping inside the cooldown window:
  // drop the event entirely, without recording it.
  Drop,
};

// Decides how to handle the next enterprise security event, so that a burst
// (for example the many Safe Browsing hits of a single page load) does not
// result in one ping per event. Only the event that opens a cooldown window is
// reported; the ones throttled behind it are discarded, not batched into the
// next ping.
//
// aBrowserId is the id of the tab the event originates from, or 0 when the load
// has no browsing context to attribute it to; events sharing an id share a
// window, across all enterprise event types. Tabs are tracked only while their
// window is open, so a tab that goes quiet or is closed costs nothing.
//
// The cooldown is read from
// "browser.safebrowsing.enterprise.telemetry.submitCooldownMs" (default 1000).
// While "browser.safebrowsing.enterprise.telemetry.testing.disableSubmit" is
// set the throttle is disabled and reset, and RecordOnly is always returned.
// Must be called on the main thread of the parent process.
[[nodiscard]] EnterprisePingAction ThrottleEnterprisePing(uint64_t aBrowserId);

// Like ThrottleEnterprisePing, but for events that are exempt from throttling
// and must always be reported: it never returns Drop, and neither consults nor
// opens a cooldown window, so an exempt event neither throttles nor is
// throttled by any tab. Use it only for events that cannot burst the way the
// Safe Browsing hits of a single page load do, such as download reputation
// verdicts, which are bounded by the downloads the user actually starts.
// RecordOnly is still returned while the testing.disableSubmit pref is set.
// Must be called on the main thread of the parent process.
[[nodiscard]] EnterprisePingAction UnthrottledEnterprisePing();

}  // namespace mozilla::enterprise

#endif  // mozilla_EnterpriseTelemetry_h
