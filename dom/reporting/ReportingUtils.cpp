/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set ts=8 sts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/dom/ReportingUtils.h"

#include "mozilla/dom/Report.h"
#include "mozilla/dom/ReportBody.h"
#include "mozilla/dom/ReportDeliver.h"
#include "mozilla/ipc/BackgroundChild.h"
#include "mozilla/ipc/BackgroundUtils.h"
#include "mozilla/ipc/PBackgroundChild.h"
#include "nsAtom.h"
#include "nsIGlobalObject.h"
#include "nsIURIMutator.h"
#include "nsNetUtil.h"

namespace mozilla::dom {

// https://w3c.github.io/reporting/#strip-url-for-use-in-reports-heading
/* static*/
void ReportingUtils::StripURL(nsIURI* aURI, nsACString& outStrippedURL) {
  // 1. If url’s scheme is not an HTTP(S) scheme, then return url’s scheme.
  if (!net::SchemeIsHttpOrHttps(aURI)) {
    aURI->GetScheme(outStrippedURL);
    return;
  }

  // 2. Set url’s fragment to the empty string.
  // 3. Set url’s username to the empty string.
  // 4. Set url’s password to the empty string.
  nsCOMPtr<nsIURI> stripped;
  if (NS_FAILED(NS_MutateURI(aURI).SetRef(""_ns).SetUserPass(""_ns).Finalize(
          stripped))) {
    // Mutating the URI failed for some reason, just return the scheme.
    aURI->GetScheme(outStrippedURL);
    return;
  }

  // 4. Return the result of executing the URL serializer on url.
  stripped->GetSpec(outStrippedURL);
}

/* static */
void ReportingUtils::Report(nsIGlobalObject* aGlobal, nsAtom* aType,
                            const nsAString& aGroupName, const nsAString& aURL,
                            ReportBody* aBody) {
  MOZ_ASSERT(aGlobal);
  MOZ_ASSERT(aBody);

  nsDependentAtomString type(aType);

  RefPtr<mozilla::dom::Report> report =
      new mozilla::dom::Report(aGlobal, type, aURL, aBody);
  aGlobal->BroadcastReport(report);

  if (!NS_IsMainThread()) {
    return;
  }

  nsCOMPtr<nsPIDOMWindowInner> window = do_QueryInterface(aGlobal);
  if (!window) {
    return;
  }

  // Send the report to the server.
  ReportDeliver::Record(window, type, aGroupName, aURL, aBody);
}

}  // namespace mozilla::dom
