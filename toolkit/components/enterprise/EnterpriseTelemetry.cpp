/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/EnterpriseTelemetry.h"

#ifdef MOZ_ENTERPRISE

#  include "mozilla/Preferences.h"
#  include "mozilla/TimeStamp.h"
#  include "mozilla/glean/GleanPings.h"
#  include "nsIURI.h"
#  include "nsNetUtil.h"
#  include "nsString.h"
#  include "nsThreadUtils.h"

namespace mozilla::enterprise {

// Time and originating tab of the last submitted enterprise ping, used to
// throttle submissions.
static TimeStamp sLastEnterprisePingTime;
static uint64_t sLastEnterpriseBrowserId = 0;

bool EventReportingEnabled(const nsACString& aPrefPrefix) {
  nsAutoCString pref(aPrefPrefix);
  pref.AppendLiteral(".enabled");
  return Preferences::GetBool(pref.get(), true);
}

void MaybeRedactUrl(const nsACString& aPrefPrefix, nsIURI* aURI,
                    nsACString& aProcessedUrl) {
  aProcessedUrl.Truncate();

  nsAutoCString pref(aPrefPrefix);
  pref.AppendLiteral(".urlLogging");

  nsAutoCString policy;
  if (NS_FAILED(Preferences::GetCString(pref.get(), policy)) ||
      policy.IsEmpty()) {
    policy.AssignLiteral("full");
  }

  if (policy.EqualsLiteral("none") || !aURI) {
    return;
  }

  if (policy.EqualsLiteral("domain")) {
    nsAutoCString host;
    if (NS_SUCCEEDED(aURI->GetHost(host))) {
      aProcessedUrl = host;
    }
  } else {
    NS_GetSanitizedURIStringFromURI(aURI, aProcessedUrl);
  }
}

EnterprisePingAction ThrottleEnterprisePing(uint64_t aBrowserId) {
  MOZ_ASSERT(NS_IsMainThread());

  if (Preferences::GetBool(
          "browser.safebrowsing.enterprise.telemetry.testing.disableSubmit",
          false)) {
    // Testing escape hatch: record so tests can inspect the event, but never
    // submit and never throttle (reset any window a prior test left behind).
    sLastEnterprisePingTime = TimeStamp();
    sLastEnterpriseBrowserId = 0;
    return EnterprisePingAction::RecordOnly;
  }

  const uint32_t cooldownMs = Preferences::GetUint(
      "browser.safebrowsing.enterprise.telemetry.submitCooldownMs", 1000);

  const TimeStamp now = TimeStamp::Now();
  const bool withinCooldown =
      !sLastEnterprisePingTime.IsNull() &&
      (now - sLastEnterprisePingTime).ToMilliseconds() < cooldownMs;

  // Only collapse a burst that comes from the same tab, so unsafe subresources
  // in one page load fold into a single ping while genuinely distinct hits in
  // other tabs are always reported. Events without a tab (aBrowserId == 0, for
  // example downloads) collapse only against each other.
  if (withinCooldown && aBrowserId == sLastEnterpriseBrowserId) {
    return EnterprisePingAction::Drop;
  }

  sLastEnterprisePingTime = now;
  sLastEnterpriseBrowserId = aBrowserId;
  return EnterprisePingAction::RecordAndSubmit;
}

}  // namespace mozilla::enterprise

#endif  // MOZ_ENTERPRISE
