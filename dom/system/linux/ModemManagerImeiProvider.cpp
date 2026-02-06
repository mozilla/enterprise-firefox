/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

#include "ModemManagerImeiProvider.h"

#include "mozilla/ClearOnShutdown.h"
#include "mozilla/GRefPtr.h"
#include "mozilla/GUniquePtr.h"
#include "mozilla/Logging.h"
#include "mozilla/dom/Promise.h"
#include "mozilla/widget/AsyncDBus.h"
#include "nsAppShell.h"
#include "nsIGlobalObject.h"

namespace mozilla::dom {

static LazyLogModule gModemManagerImeiLog("ModemManagerImei");

#define MMI_LOG(level, ...) \
  MOZ_LOG(gModemManagerImeiLog, mozilla::LogLevel::level, (__VA_ARGS__))

StaticRefPtr<ModemManagerImeiProvider> sInstance;

/* static */
already_AddRefed<ModemManagerImeiProvider>
ModemManagerImeiProvider::GetInstance() {
  if (!sInstance) {
    sInstance = new ModemManagerImeiProvider();
    ClearOnShutdown(&sInstance);
  }

  RefPtr<ModemManagerImeiProvider> service = sInstance.get();
  return service.forget();
}

static const char* const kModemManagerBusName = "org.freedesktop.ModemManager1";
static const char* const kModemRootPath =
    "/org/freedesktop/ModemManager1/Modem";
static const char* const kModemInterface =
    "org.freedesktop.ModemManager1.Modem";
static const char* const kDbusIntrospectable =
    "org.freedesktop.DBus.Introspectable";

NS_IMPL_ISUPPORTS(ModemManagerImeiProvider, nsIImeiProvider)

NS_IMETHODIMP
ModemManagerImeiProvider::GetImei(JSContext* aCx, Promise** aResult) {
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

  CollectImei(promise);

  promise.forget(aResult);
  return NS_OK;
}

void ModemManagerImeiProvider::QueryModemImei(RefPtr<Promise> aPromise) {
  MMI_LOG(Debug, "%s query modem %s", __PRETTY_FUNCTION__,
          mRealModemPath.get());

  widget::CreateDBusProxyForBus(
      G_BUS_TYPE_SYSTEM, GDBusProxyFlags(G_DBUS_PROXY_FLAGS_NONE), nullptr,
      kModemManagerBusName, mRealModemPath.get(), kModemInterface, mCancellable)
      ->Then(
          GetCurrentSerialEventTarget(), __func__,
          [aPromise](RefPtr<GDBusProxy>&& aProxy) {
            RefPtr<GVariant> variant =
                dont_AddRef(g_dbus_proxy_get_cached_property(
                    aProxy, "EquipmentIdentifier"));

            if (!variant) {
              MMI_LOG(Error, "Failure getting cached value %s\n",
                      "EquipmentIdentifier");
              aPromise->MaybeReject(NS_ERROR_ILLEGAL_VALUE);
              return;
            }

            if (!g_variant_is_of_type(variant, G_VARIANT_TYPE_STRING)) {
              MMI_LOG(Error, "Unexpected %s type: %s\n", "EquipmentIdentifier",
                      g_variant_get_type_string(variant));
              aPromise->MaybeReject(NS_ERROR_ILLEGAL_VALUE);
              return;
            }

            const gchar* imeiValue = g_variant_get_string(variant, nullptr);
            MMI_LOG(Debug, "%s IMEI: %s\n", __PRETTY_FUNCTION__, imeiValue);

            aPromise->MaybeResolve(nsCString(imeiValue));
          },
          [aPromise](GUniquePtr<GError>&& aError) {
            MMI_LOG(Error, "Failed to get modem: %s\n", aError->message);
            aPromise->MaybeReject(NS_ERROR_INVALID_ARG);
          });
}

void ModemManagerImeiProvider::OnIntrospectFinish(RefPtr<Promise> aPromise,
                                                  RefPtr<GVariant> aResult) {
  gchar* introspectXml;
  g_variant_get(aResult, "(&s)", &introspectXml);

  GUniquePtr<GError> error;
  RefPtr<GDBusNodeInfo> nodeInfos = dont_AddRef(
      g_dbus_node_info_new_for_xml(introspectXml, getter_Transfers(error)));
  if (!nodeInfos) {
    MMI_LOG(Error, "g_dbus_node_info_new_for_xml() failed! %s", error->message);
    aPromise->MaybeReject(NS_ERROR_FAILURE);
    return;
  }

  if (!nodeInfos->nodes) {
    MMI_LOG(Error, "nodeInfos->nodes failed! %s", error->message);
    aPromise->MaybeReject(NS_ERROR_FAILURE);
    g_dbus_node_info_unref(nodeInfos);
    return;
  }

  for (int n = 0; nodeInfos->nodes != NULL && nodeInfos->nodes[n] != NULL;
       n++) {
    if (nodeInfos->nodes[n]) {
      MMI_LOG(Error, "Query IMEI@%d: %s", n, nodeInfos->nodes[n]->path);
      mRealModemPath =
          nsPrintfCString("%s/%s", kModemRootPath, nodeInfos->nodes[n]->path);
      QueryModemImei(aPromise);
      g_dbus_node_info_unref(nodeInfos);
      return;
    }
  }

  aPromise->MaybeReject(NS_ERROR_NOT_IMPLEMENTED);
  g_dbus_node_info_unref(nodeInfos);
  return;
}

void ModemManagerImeiProvider::CollectImei(RefPtr<Promise> aPromise) {
  widget::CreateDBusProxyForBus(
      G_BUS_TYPE_SYSTEM, GDBusProxyFlags(G_DBUS_PROXY_FLAGS_NONE), nullptr,
      kModemManagerBusName, kModemRootPath, kDbusIntrospectable, mCancellable)
      ->Then(
          GetCurrentSerialEventTarget(), __func__,
          [aPromise, self = RefPtr{this}](RefPtr<GDBusProxy>&& aProxy) {
            widget::DBusProxyCall(aProxy, "Introspect", nullptr,
                                  G_DBUS_CALL_FLAGS_NONE, -1,
                                  self->mCancellable)
                ->Then(
                    GetCurrentSerialEventTarget(), __func__,
                    [aPromise, self](RefPtr<GVariant>&& aResult) {
                      self->OnIntrospectFinish(std::move(aPromise),
                                               std::move(aResult));
                    },
                    [aPromise](GUniquePtr<GError>&& aError) {
                      MMI_LOG(Error, "Failed to introspect modems: %s\n",
                              aError->message);
                      aPromise->MaybeReject(NS_ERROR_FAILURE);
                    });
          },
          [aPromise](GUniquePtr<GError>&& aError) {
            MMI_LOG(Error, "Failed to get modems: %s\n", aError->message);
            aPromise->MaybeReject(NS_ERROR_PROXY_NOT_FOUND);
          });
}

}  // namespace mozilla::dom
