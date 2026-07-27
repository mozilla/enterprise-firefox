/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/EnterpriseTelemetry.h"

#ifdef MOZ_ENTERPRISE

#  include "MainThreadUtils.h"
#  include "mozilla/ClearOnShutdown.h"
#  include "mozilla/Preferences.h"
#  include "mozilla/StaticPtr.h"
#  include "mozilla/TimeStamp.h"
#  include "nsIURI.h"
#  include "nsNetUtil.h"
#  include "nsTHashMap.h"

namespace mozilla::enterprise {

// Time of the last submitted enterprise ping, per originating tab.
static StaticAutoPtr<nsTHashMap<uint64_t, TimeStamp>> sLastPingTimes;

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
  Preferences::GetCString(pref.get(), policy);

  if (!aURI || policy.EqualsLiteral("none")) {
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

// Testing escape hatch: tests record events but never submit. Also resets the
// throttle, so a window a prior test left behind cannot leak into the next one.
static bool SubmitDisabledForTesting() {
  if (!Preferences::GetBool(
          "browser.safebrowsing.enterprise.telemetry.testing.disableSubmit",
          false)) {
    return false;
  }

  if (sLastPingTimes) {
    sLastPingTimes->Clear();
  }
  return true;
}

EnterprisePingAction UnthrottledEnterprisePing() {
  MOZ_ASSERT(NS_IsMainThread());

  return SubmitDisabledForTesting() ? EnterprisePingAction::RecordOnly
                                    : EnterprisePingAction::RecordAndSubmit;
}

EnterprisePingAction ThrottleEnterprisePing(uint64_t aBrowserId) {
  MOZ_ASSERT(NS_IsMainThread());

  if (SubmitDisabledForTesting()) {
    return EnterprisePingAction::RecordOnly;
  }

  if (!sLastPingTimes) {
    sLastPingTimes = new nsTHashMap<uint64_t, TimeStamp>();
    ClearOnShutdown(&sLastPingTimes);
  }

  const uint32_t cooldownMs = Preferences::GetUint(
      "browser.safebrowsing.enterprise.telemetry.submitCooldownMs", 60000);
  const TimeStamp now = TimeStamp::Now();

  // A tab whose window has elapsed can no longer be throttled, so drop it here
  // rather than growing the map by every tab that ever reported an event. This
  // also means any surviving entry is inside its window by construction.
  for (auto iter = sLastPingTimes->Iter(); !iter.Done(); iter.Next()) {
    const double dt = (now - iter.Data()).ToMilliseconds();
    if (dt >= cooldownMs) {
      iter.Remove();
    }
  }

  // Each tab gets its own cooldown window, so one page load reports its first
  // unsafe hit and discards the rest, while hits in other tabs are reported on
  // their own schedule. Events whose load has no browsing context to attribute
  // it to (aBrowserId == 0) share a single window among themselves.
  if (sLastPingTimes->Contains(aBrowserId)) {
    return EnterprisePingAction::Drop;
  }

  sLastPingTimes->InsertOrUpdate(aBrowserId, now);
  return EnterprisePingAction::RecordAndSubmit;
}

}  // namespace mozilla::enterprise

#endif  // MOZ_ENTERPRISE
