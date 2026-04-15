/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "WAICTUtils.h"

#include <cstdint>

#include "mozilla/net/SFVService.h"
#include "nsCOMPtr.h"
#include "nsString.h"

namespace mozilla::waict {

LazyLogModule gWaictLog("WAICT");

Result<nsCString, nsresult> ParseManifest(nsISFVDictionary* aDict) {
  nsCOMPtr<nsISFVItemOrInnerList> manifest;
  MOZ_TRY(aDict->Get("manifest"_ns, getter_AddRefs(manifest)));

  nsCOMPtr<nsISFVItem> manifestItem = do_QueryInterface(manifest);
  if (!manifestItem) {
    return Err(NS_ERROR_FAILURE);
  }

  nsCOMPtr<nsISFVBareItem> value;
  MOZ_TRY(manifestItem->GetValue(getter_AddRefs(value)));

  nsCOMPtr<nsISFVString> stringVal = do_QueryInterface(value);
  if (!stringVal) {
    return Err(NS_ERROR_FAILURE);
  }

  nsAutoCString manifestURL;
  MOZ_TRY(stringVal->GetValue(manifestURL));
  if (!manifestURL.IsEmpty()) {
    return manifestURL;
  }

  return Err(NS_ERROR_FAILURE);
}

Result<uint64_t, nsresult> ParseMaxAge(nsISFVDictionary* aDict) {
  nsCOMPtr<nsISFVItemOrInnerList> maxAge;
  MOZ_TRY(aDict->Get("max-age"_ns, getter_AddRefs(maxAge)));

  nsCOMPtr<nsISFVItem> maxAgeItem = do_QueryInterface(maxAge);
  if (!maxAgeItem) {
    return Err(NS_ERROR_FAILURE);
  }

  nsCOMPtr<nsISFVBareItem> maxAgeValue;
  MOZ_TRY(maxAgeItem->GetValue(getter_AddRefs(maxAgeValue)));

  nsCOMPtr<nsISFVInteger> intVal = do_QueryInterface(maxAgeValue);
  if (!intVal) {
    return Err(NS_ERROR_FAILURE);
  }

  int64_t maxAgeSeconds;
  MOZ_TRY(intVal->GetValue(&maxAgeSeconds));
  if (maxAgeSeconds >= 0) {
    return maxAgeSeconds;
  }

  return Err(NS_ERROR_FAILURE);
}

Result<WaictMode, nsresult> ParseMode(nsISFVDictionary* aDict) {
  nsCOMPtr<nsISFVItemOrInnerList> mode;
  MOZ_TRY(aDict->Get("mode"_ns, getter_AddRefs(mode)));

  nsCOMPtr<nsISFVItem> modeItem = do_QueryInterface(mode);
  if (!modeItem) {
    return Err(NS_ERROR_FAILURE);
  }

  nsCOMPtr<nsISFVBareItem> modeValue;
  MOZ_TRY(modeItem->GetValue(getter_AddRefs(modeValue)));

  nsCOMPtr<nsISFVToken> tokenVal = do_QueryInterface(modeValue);
  if (!tokenVal) {
    return Err(NS_ERROR_FAILURE);
  }

  nsAutoCString token;
  MOZ_TRY(tokenVal->GetValue(token));

  if (token.EqualsLiteral("enforce")) {
    return WaictMode::Enforce;
  }
  if (token.EqualsLiteral("report")) {
    return WaictMode::Report;
  }

  return Err(NS_ERROR_FAILURE);
}

}  // namespace mozilla::waict
