/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/EnterpriseTelemetry.h"

#ifdef MOZ_ENTERPRISE

#  include "mozilla/Preferences.h"
#  include "mozilla/TimeStamp.h"
#  include "mozilla/glean/GleanPings.h"
#  include "nsIURI.h"
#  include "nsString.h"
#  include "nsThreadUtils.h"

namespace mozilla::enterprise {

bool EventReportingEnabled(const nsACString& aPrefPrefix) {
  nsAutoCString pref(aPrefPrefix);
  pref.AppendLiteral(".enabled");
  return Preferences::GetBool(pref.get(), true);
}

void RedactUrl(const nsACString& aPrefPrefix, nsIURI* aURI,
               nsACString& aResult) {
  aResult.Truncate();

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
      aResult = host;
    }
  } else {
    nsAutoCString spec;
    if (NS_SUCCEEDED(aURI->GetSpec(spec))) {
      aResult = spec;
    }
  }
}

// Time the last enterprise ping was submitted, used to throttle submissions.
static TimeStamp sLastEnterprisePingTime;

void MaybeSubmitEnterprisePing() {
  MOZ_ASSERT(NS_IsMainThread());

  if (Preferences::GetBool(
          "browser.safebrowsing.enterprise.telemetry.testing.disableSubmit",
          false)) {
    return;
  }

  uint32_t cooldownMs = Preferences::GetUint(
      "browser.safebrowsing.enterprise.telemetry.submitCooldownMs", 1000);

  TimeStamp now = TimeStamp::Now();
  if (!sLastEnterprisePingTime.IsNull() &&
      (now - sLastEnterprisePingTime).ToMilliseconds() < cooldownMs) {
    // Still within the cooldown window opened by the last submitted ping; drop
    // this ping. The event has already been staged and will be sent with the
    // next ping submitted after the cooldown has elapsed.
    return;
  }

  sLastEnterprisePingTime = now;
  glean_pings::Enterprise.Submit();
}

}  // namespace mozilla::enterprise

#endif  // MOZ_ENTERPRISE
