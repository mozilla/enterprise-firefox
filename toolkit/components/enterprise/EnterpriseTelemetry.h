/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_EnterpriseTelemetry_h
#define mozilla_EnterpriseTelemetry_h

#ifdef MOZ_ENTERPRISE

#  include <cstdint>

#  include "nsStringFwd.h"

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
  // The cooldown has elapsed, or the event comes from a different tab: record
  // the event and then submit the enterprise ping
  // (glean_pings::Enterprise.Submit()).
  RecordAndSubmit,
  // Submission is disabled via the testing.disableSubmit pref: still record the
  // event so tests can inspect it, but do not submit a ping.
  RecordOnly,
  // The event comes from the same tab as the last submission and is inside the
  // cooldown window: drop it entirely, without recording it.
  Drop,
};

// Decides how to handle the next enterprise security event, throttling
// submissions so a burst of events (for example the many Safe Browsing hits
// produced by a single page load) does not result in one ping per event. A
// single cooldown window is shared across all enterprise event types.
//
// aBrowserId is the id of the tab the event originates from, or 0 when there is
// no tab (for example downloads). A burst is only collapsed when the follow-up
// events come from the same tab, so unsafe subresources in one page load fold
// into a single ping while genuinely distinct hits in other tabs are always
// reported. The cooldown interval is read from
// "browser.safebrowsing.enterprise.telemetry.submitCooldownMs" (default 1000).
// While the "browser.safebrowsing.enterprise.telemetry.testing.disableSubmit"
// pref is set the throttle is disabled and reset, and RecordOnly is always
// returned. Must be called on the main thread of the parent process.
[[nodiscard]] EnterprisePingAction ThrottleEnterprisePing(uint64_t aBrowserId);

}  // namespace mozilla::enterprise

#endif  // MOZ_ENTERPRISE
#endif  // mozilla_EnterpriseTelemetry_h
