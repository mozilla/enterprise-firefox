/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/EnterpriseTelemetry.h"

#ifdef MOZ_ENTERPRISE

#  include "mozilla/ClearOnShutdown.h"
#  include "mozilla/Preferences.h"
#  include "mozilla/StaticPtr.h"
#  include "mozilla/TimeStamp.h"
#  include "nsIURI.h"
#  include "nsNetUtil.h"
#  include "nsTHashMap.h"

namespace mozilla::enterprise {

// Time of the last submitted enterprise ping per originating tab, used to
// throttle submissions. Entries older than the cooldown are pruned on every
// call, so this only ever holds the tabs that submitted within the current
// window.
static StaticAutoPtr<nsTHashMap<nsUint64HashKey, TimeStamp>>
    sLastEnterprisePingTimes;

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
    if (sLastEnterprisePingTimes) {
      sLastEnterprisePingTimes->Clear();
    }
    return EnterprisePingAction::RecordOnly;
  }

  const uint32_t cooldownMs = Preferences::GetUint(
      "browser.safebrowsing.enterprise.telemetry.submitCooldownMs", 1000);

  const TimeStamp now = TimeStamp::Now();

  if (!sLastEnterprisePingTimes) {
    sLastEnterprisePingTimes = new nsTHashMap<nsUint64HashKey, TimeStamp>();
    ClearOnShutdown(&sLastEnterprisePingTimes);
  }

  // A tab whose window has elapsed can no longer be throttled, so drop it here
  // rather than growing the map by every tab that ever reported an event. This
  // also means any surviving entry is inside the window by construction.
  for (auto iter = sLastEnterprisePingTimes->Iter(); !iter.Done();
       iter.Next()) {
    const auto dt = (now - iter.Data()).ToMilliseconds();
    if (dt >= cooldownMs) {
      iter.Remove();
    }
  }

  // Each tab gets its own cooldown window, so one page load reports its first
  // unsafe hit and discards the rest, while hits in other tabs are reported on
  // their own schedule. Events without a tab (aBrowserId == 0, for example
  // downloads) share a single window among themselves.
  if (sLastEnterprisePingTimes->Contains(aBrowserId)) {
    return EnterprisePingAction::Drop;
  }

  sLastEnterprisePingTimes->InsertOrUpdate(aBrowserId, now);
  return EnterprisePingAction::RecordAndSubmit;
}

}  // namespace mozilla::enterprise

#endif  // MOZ_ENTERPRISE
