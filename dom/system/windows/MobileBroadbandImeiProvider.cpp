/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

#include "MobileBroadbandImeiProvider.h"

#include <mbnapi.h>
#include <windows.h>

#include "mozilla/ClearOnShutdown.h"
#include "mozilla/Logging.h"
#include "mozilla/dom/Promise.h"
#include "nsAppShell.h"
#include "nsCOMPtr.h"

namespace mozilla::dom {

static LazyLogModule gMobileBroadbandImeiLog("MobileBroadbandImei");

#define MBNI_LOG(level, ...) \
  MOZ_LOG(gMobileBroadbandImeiLog, mozilla::LogLevel::level, (__VA_ARGS__))

StaticRefPtr<MobileBroadbandImeiProvider> sInstance;

/* static */
already_AddRefed<MobileBroadbandImeiProvider>
MobileBroadbandImeiProvider::GetInstance() {
  if (!sInstance) {
    sInstance = new MobileBroadbandImeiProvider();
    ClearOnShutdown(&sInstance);
  }

  RefPtr<MobileBroadbandImeiProvider> service = sInstance.get();
  return service.forget();
}

NS_IMPL_ISUPPORTS(MobileBroadbandImeiProvider, nsIImeiProvider)

NS_IMETHODIMP
MobileBroadbandImeiProvider::GetImei(JSContext* aCx, Promise** aResult) {
  NS_ENSURE_ARG_POINTER(aResult);
  *aResult = nullptr;

  if (!XRE_IsParentProcess()) {
    return NS_ERROR_FAILURE;
  }

  nsIGlobalObject* global = xpc::CurrentNativeGlobal(aCx);
  if (NS_WARN_IF(!global)) {
    return NS_ERROR_FAILURE;
  }

  ErrorResult erv;
  RefPtr<Promise> promise = Promise::Create(global, erv);
  if (NS_WARN_IF(erv.Failed())) {
    return erv.StealNSResult();
  }

  auto promiseHolder =
      MakeRefPtr<nsMainThreadPtrHolder<Promise>>("GetImei promise", promise);

  nsresult rv = NS_DispatchBackgroundTask(
      NS_NewRunnableFunction(
          "MobileBroadbandImeiProvider::GetImei",
          [promiseHolder] {
            auto getImeiValue = [](nsAString& imeiString) {
              IMbnInterfaceManager* pMbnInterfaceManager = nullptr;
              HRESULT hr =
                  CoCreateInstance(__uuidof(MbnInterfaceManager), nullptr,
                                   CLSCTX_ALL, __uuidof(IMbnInterfaceManager),
                                   (void**)&pMbnInterfaceManager);
              if (FAILED(hr)) {
                MBNI_LOG(Error, "%s CoCreateInstance() FAIL %08lx\n",
                         __PRETTY_FUNCTION__, hr);
                pMbnInterfaceManager->Release();
                return NS_ERROR_FAILURE;
              }

              SAFEARRAY* psaInterfaces = nullptr;
              hr = pMbnInterfaceManager->GetInterfaces(&psaInterfaces);
              if (FAILED(hr)) {
                MBNI_LOG(Error, "%s GetInterfaces() FAIL %08lx\n",
                         __PRETTY_FUNCTION__, hr);
                return NS_ERROR_FAILURE;
              }

              LONG lowerBound, upperBound;
              SafeArrayGetLBound(psaInterfaces, 1, &lowerBound);
              SafeArrayGetUBound(psaInterfaces, 1, &upperBound);

              for (LONG i = lowerBound; i <= upperBound; i++) {
                IMbnInterface* pMbnInterface = nullptr;
                hr = SafeArrayGetElement(psaInterfaces, &i, &pMbnInterface);
                if (FAILED(hr)) {
                  MBNI_LOG(Error, "%s SafeArrayGetElement[%ld] failed: %08lx\n",
                           __PRETTY_FUNCTION__, i, hr);
                  pMbnInterface->Release();
                  continue;
                }

                MBN_INTERFACE_CAPS caps;
                hr = pMbnInterface->GetInterfaceCapability(&caps);
                if (FAILED(hr)) {
                  MBNI_LOG(Error,
                           "%s GetInterfaceCapability %ld failed: %08lx\n",
                           __PRETTY_FUNCTION__, i, hr);
                  pMbnInterface->Release();
                  continue;
                }

                MBNI_LOG(Debug, "%s IMEI(%ld): %ls\n", __PRETTY_FUNCTION__, i,
                         caps.deviceID);
                imeiString.Assign(caps.deviceID);

                pMbnInterface->Release();
              }

              SafeArrayDestroy(psaInterfaces);
              pMbnInterfaceManager->Release();

              return NS_OK;
            };

            nsString imeiValue;
            nsresult rv_imei = getImeiValue(imeiValue);

            NS_DispatchToMainThread(NS_NewRunnableFunction(
                "GetImei callback", [rv_imei, promiseHolder, imeiValue] {
                  Promise* promise = promiseHolder.get()->get();
                  if (NS_SUCCEEDED(rv_imei)) {
                    promise->MaybeResolve(imeiValue);
                  } else {
                    promise->MaybeReject(rv_imei);
                  }
                }));
          }),
      NS_DISPATCH_EVENT_MAY_BLOCK);

  promise.forget(aResult);
  return rv;
}

}  // namespace mozilla::dom
