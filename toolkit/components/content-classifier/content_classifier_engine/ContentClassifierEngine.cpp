/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

#include "mozilla/ContentClassifierEngine.h"
#include "ContentClassifierFeatureUtils.h"
#include "ContentClassifierService.h"
#include "mozilla/extensions/WebExtensionPolicy.h"
#include "nsIEffectiveTLDService.h"
#include "nsNetUtil.h"
#include "mozilla/Components.h"
#include "mozIThirdPartyUtil.h"

namespace mozilla {

namespace {

bool IsNonRecommendedAddonFromLoadInfo(nsILoadInfo* aLoadInfo) {
  MOZ_ASSERT(aLoadInfo);
  extensions::WebExtensionPolicy* policy =
      ContentClassifierFeatureUtils::GetAddonPolicyFromLoadInfo(aLoadInfo);
  return policy && !policy->HasRecommendedState();
}

}  // namespace

ContentClassifierEngineResult ContentClassifierEngine::CheckNetworkRequest(
    const ContentClassifierRequest& aRequest, bool aPreviouslyMatched) {
  if (!mEngine || !sInitializedETLDService) {
    return ContentClassifierEngineResult(NS_ERROR_NOT_INITIALIZED, mFeature);
  }

  if (!aRequest.mValid) {
    return ContentClassifierEngineResult(NS_ERROR_INVALID_ARG, mFeature);
  }

  bool matched = false;
  bool important = false;
  nsCString exception;

  nsresult rv = content_classifier_engine_check_network_request_preparsed(
      mEngine, &aRequest.mUrl, &aRequest.mSchemelessSite,
      &aRequest.mSourceSchemelessSite, &aRequest.mRequestType,
      aRequest.mThirdParty, aPreviouslyMatched, &matched, &important,
      &exception);
  return ContentClassifierEngineResult(matched, !exception.IsEmpty(), important,
                                       rv, mFeature);
}

ContentClassifierRequest::ContentClassifierRequest(nsIChannel* aChannel)
    : mThirdParty(true), mValid(false) {
  nsCOMPtr<nsIURI> uri;
  nsresult rv = aChannel->GetURI(getter_AddRefs(uri));
  if (NS_FAILED(rv)) return;

  rv = uri->GetSpec(mUrl);
  if (NS_FAILED(rv)) return;

  nsCString host;
  rv = uri->GetHost(host);
  if (NS_FAILED(rv)) return;

  nsCOMPtr<nsIEffectiveTLDService> eTLDService =
      components::EffectiveTLD::Service();
  if (!eTLDService) return;

  rv = eTLDService->GetSchemelessSiteFromHost(host, mSchemelessSite);
  if (NS_FAILED(rv)) return;

  nsCOMPtr<nsILoadInfo> loadInfo;
  rv = aChannel->GetLoadInfo(getter_AddRefs(loadInfo));
  if (NS_FAILED(rv)) return;

  // Best-effort: some principals (extension, null, system) have no usable
  // base domain. Leave mSourceSchemelessSite empty rather than invalidating
  // the whole request.
  nsCOMPtr<nsIPrincipal> loadingPrincipal = loadInfo->GetLoadingPrincipal();
  if (loadingPrincipal) {
    (void)loadingPrincipal->GetBaseDomain(mSourceSchemelessSite);
  }

  ExtContentPolicyType contentPolicyType =
      loadInfo->GetExternalContentPolicyType();
  switch (contentPolicyType) {
    case ExtContentPolicyType::TYPE_CSP_REPORT:
      mRequestType.AssignLiteral("csp_report");
      break;
    case ExtContentPolicyType::TYPE_DOCUMENT:
      mRequestType.AssignLiteral("document");
      break;
    case ExtContentPolicyType::TYPE_FONT:
      mRequestType.AssignLiteral("font");
      break;
    case ExtContentPolicyType::TYPE_IMAGE:
    case ExtContentPolicyType::TYPE_IMAGESET:
      mRequestType.AssignLiteral("image");
      break;
    case ExtContentPolicyType::TYPE_MEDIA:
      mRequestType.AssignLiteral("media");
      break;
    case ExtContentPolicyType::TYPE_OBJECT:
      mRequestType.AssignLiteral("object");
      break;
    case ExtContentPolicyType::TYPE_BEACON:
    case ExtContentPolicyType::TYPE_PING:
      mRequestType.AssignLiteral("ping");
      break;
    case ExtContentPolicyType::TYPE_SCRIPT:
      mRequestType.AssignLiteral("script");
      break;
    case ExtContentPolicyType::TYPE_STYLESHEET:
      mRequestType.AssignLiteral("stylesheet");
      break;
    case ExtContentPolicyType::TYPE_SUBDOCUMENT:
      mRequestType.AssignLiteral("subdocument");
      break;
    case ExtContentPolicyType::TYPE_WEBSOCKET:
      mRequestType.AssignLiteral("websocket");
      break;
    case ExtContentPolicyType::TYPE_XMLHTTPREQUEST:
      mRequestType.AssignLiteral("xmlhttprequest");
      break;
    default:
      mRequestType.AssignLiteral("other");
      break;
  }

  nsCOMPtr<mozIThirdPartyUtil> thirdPartyUtil =
      components::ThirdPartyUtil::Service();
  if (!thirdPartyUtil) {
    return;
  }
  rv = thirdPartyUtil->IsThirdPartyChannel(aChannel, nullptr, &mThirdParty);
  if (NS_FAILED(rv)) {
    mThirdParty = true;
  }

  mPrivateBrowsing = NS_UsePrivateBrowsing(aChannel);

  mIsNonRecommendedAddon = IsNonRecommendedAddonFromLoadInfo(loadInfo);

  mValid = true;
}

}  // namespace mozilla
