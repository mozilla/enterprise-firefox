/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

#include "PackageKitDBusProvider.h"

#include "mozilla/dom/BindingUtils.h"
#include "mozilla/dom/BindingDeclarations.h"
#include "mozilla/dom/Promise.h"

#include "mozilla/ClearOnShutdown.h"
#include "mozilla/GRefPtr.h"
#include "mozilla/GUniquePtr.h"
#include "mozilla/Logging.h"
#include "mozilla/widget/AsyncDBus.h"

#include "nsIServiceManager.h"
#include "nsIXULAppInfo.h"
#include "nsServiceManagerUtils.h"
#include "nsString.h"
#include "nsIGlobalObject.h"
#include "xpcpublic.h"

#ifndef G_DBUS_CALL_FLAGS_ALLOW_INTERACTIVE_AUTHORIZATION
#  define G_DBUS_CALL_FLAGS_ALLOW_INTERACTIVE_AUTHORIZATION \
    static_cast<GDBusCallFlags>(2)
#endif

namespace mozilla::dom {

using namespace mozilla::widget;

static LazyLogModule gPackageKitDBusLog("PackageKitDBus");

#define PKDB_LOG(level, ...) \
  MOZ_LOG(gPackageKitDBusLog, mozilla::LogLevel::level, (__VA_ARGS__))

NS_IMPL_ISUPPORTS(PackageKitPercentage, nsIPackageKitPercentage)

NS_IMETHODIMP
PackageKitPercentage::GetPercentage(uint32_t* aPercentage) {
  NS_ENSURE_ARG_POINTER(aPercentage);
  *aPercentage = mPercentage;
  return NS_OK;
}

// ---------------------------------------------------------------------------
// nsIPackageKitSignalPackage implementation
// ---------------------------------------------------------------------------

class PackageKitSignalPackageResult final : public nsIPackageKitSignalPackage {
 public:
  NS_DECL_ISUPPORTS

  PackageKitSignalPackageResult(uint32_t aInfo, nsCString aPackageId,
                                nsCString aSummary)
      : mInfo(aInfo),
        mPackageId(std::move(aPackageId)),
        mSummary(std::move(aSummary)) {}

  NS_IMETHOD GetInfo(uint32_t* aInfo) override {
    *aInfo = mInfo;
    return NS_OK;
  }
  NS_IMETHOD GetPackageId(nsACString& aPackageId) override {
    aPackageId = mPackageId;
    return NS_OK;
  }
  NS_IMETHOD GetSummary(nsACString& aSummary) override {
    aSummary = mSummary;
    return NS_OK;
  }

 private:
  ~PackageKitSignalPackageResult() = default;
  uint32_t mInfo;
  nsCString mPackageId;
  nsCString mSummary;
};

NS_IMPL_ISUPPORTS(PackageKitSignalPackageResult, nsIPackageKitSignalPackage)

// ---------------------------------------------------------------------------
// nsIPackageKitSignalFiles implementation
// ---------------------------------------------------------------------------

class PackageKitSignalFilesResult final : public nsIPackageKitSignalFiles {
 public:
  NS_DECL_ISUPPORTS

  PackageKitSignalFilesResult(nsCString aPackageId,
                              nsTArray<nsCString> aFileList)
      : mPackageId(std::move(aPackageId)), mFileList(std::move(aFileList)) {}

  NS_IMETHOD GetPackageId(nsACString& aPackageId) override {
    aPackageId = mPackageId;
    return NS_OK;
  }
  NS_IMETHOD GetFileList(nsTArray<nsCString>& aFileList) override {
    aFileList = std::move(mFileList);
    return NS_OK;
  }

 private:
  ~PackageKitSignalFilesResult() = default;
  nsCString mPackageId;
  nsTArray<nsCString> mFileList;
};

NS_IMPL_ISUPPORTS(PackageKitSignalFilesResult, nsIPackageKitSignalFiles)

// ---------------------------------------------------------------------------
// nsIPackageKitSignalProgress implementation
// ---------------------------------------------------------------------------

class PackageKitSignalProgressResult final
    : public nsIPackageKitSignalProgress {
 public:
  NS_DECL_ISUPPORTS

  PackageKitSignalProgressResult(nsCString aId, uint32_t aStatus,
                                 uint32_t aPercentage)
      : mId(std::move(aId)), mStatus(aStatus), mPercentage(aPercentage) {}

  NS_IMETHOD GetId(nsACString& aId) override {
    aId = mId;
    return NS_OK;
  }
  NS_IMETHOD GetStatus(uint32_t* aStatus) override {
    *aStatus = mStatus;
    return NS_OK;
  }
  NS_IMETHOD GetPercentage(uint32_t* aPercentage) override {
    *aPercentage = mPercentage;
    return NS_OK;
  }

 private:
  ~PackageKitSignalProgressResult() = default;
  nsCString mId;
  uint32_t mStatus;
  uint32_t mPercentage;
};

NS_IMPL_ISUPPORTS(PackageKitSignalProgressResult, nsIPackageKitSignalProgress)

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

StaticRefPtr<PackageKitDBusProvider> sPackageKitDBusProviderInstance;

/* static */
already_AddRefed<PackageKitDBusProvider> PackageKitDBusProvider::GetInstance() {
  if (!sPackageKitDBusProviderInstance) {
    sPackageKitDBusProviderInstance = new PackageKitDBusProvider();
    ClearOnShutdown(&sPackageKitDBusProviderInstance);
  }
  RefPtr<PackageKitDBusProvider> service =
      sPackageKitDBusProviderInstance.get();
  return service.forget();
}

// ---------------------------------------------------------------------------
// D-Bus constants
// ---------------------------------------------------------------------------

static constexpr const char* kPKService = "org.freedesktop.PackageKit";
static constexpr const char* kPKObjectPath = "/org/freedesktop/PackageKit";
static constexpr const char* kPKInterface = "org.freedesktop.PackageKit";
static constexpr const char* kPKTransactionInterface =
    "org.freedesktop.PackageKit.Transaction";

static constexpr uint32_t kPKExitSuccess = 1;
static constexpr uint64_t kPKFilterNone = 0;
static constexpr uint64_t kPKFilterInstalled = (1ULL << 2);

// ---------------------------------------------------------------------------
// Generic transaction state
//
// Both GetUpdates and DownloadPackages share the same structure:
//   - a promise to settle
//   - an array of results (type differs)
//   - a transaction proxy kept alive until Finished
//   - Finished + ErrorCode subscription IDs (common to all transactions)
//   - up to 2 operation-specific subscription IDs (mSignalId1/2)
//
// Using a template avoids duplicating the struct and UnsubscribeAll for each
// operation, and lets HandleErrorCodeSignal / HandleFinishedSignal be shared.
// ---------------------------------------------------------------------------

template <typename PromisePrivateType, typename ResultType>
struct PKTransactionState {
  explicit PKTransactionState(RefPtr<PromisePrivateType> aPromise)
      : mPromise(std::move(aPromise)) {}

  RefPtr<PromisePrivateType> mPromise;
  nsTArray<ResultType> mResults;
  RefPtr<GDBusProxy> mTransactionProxy;

  // Shared signal subscription IDs
  guint mFinishedSignalId{0};
  guint mErrorCodeSignalId{0};

  // Operation-specific signal IDs:
  //   GetUpdates:       mSignalId1 = Package, mSignalId2 = Packages
  //   DownloadPackages: mSignalId1 = Files,   mSignalId2 = unused
  guint mSignalId1{0};
  guint mSignalId2{0};

  void UnsubscribeAll(GDBusConnection* aConnection) {
    guint* ids[] = {&mSignalId1, &mSignalId2, &mFinishedSignalId,
                    &mErrorCodeSignalId};
    for (guint* id : ids) {
      if (*id) {
        g_dbus_connection_signal_unsubscribe(aConnection, *id);
        *id = 0;
      }
    }
  }
};

using GetUpdatesState =
    PKTransactionState<PackageKitSignalsPackagePromise::Private,
                       PackageKitSignalPackage>;

struct DownloadPackagesState
    : public PKTransactionState<PackageKitSignalsFilesPromise::Private,
                                PackageKitSignalFiles> {
  DownloadPackagesState(RefPtr<PackageKitSignalsFilesPromise::Private> aPromise,
                        nsCOMPtr<nsIPackageKitProgressCallback> aCallback)
      : PKTransactionState(std::move(aPromise)),
        mCallback(std::move(aCallback)) {}

  nsCOMPtr<nsIPackageKitProgressCallback> mCallback;
  guint mPropertiesSignalId{0};
};

struct RefreshCacheState
    : public PKTransactionState<PackageKitSignalsProgressPromise::Private,
                                PackageKitSignalProgress> {
  RefreshCacheState(RefPtr<PackageKitSignalsProgressPromise::Private> aPromise,
                    nsCOMPtr<nsIPackageKitProgressCallback> aCallback)
      : PKTransactionState(std::move(aPromise)),
        mCallback(std::move(aCallback)) {}

  nsCOMPtr<nsIPackageKitProgressCallback> mCallback;
};

struct UpdatePackagesState
    : public PKTransactionState<PackageKitSignalsProgressPromise::Private,
                                PackageKitSignalProgress> {
  UpdatePackagesState(
      RefPtr<PackageKitSignalsProgressPromise::Private> aPromise,
      nsCOMPtr<nsIPackageKitProgressCallback> aCallback)
      : PKTransactionState(std::move(aPromise)),
        mCallback(std::move(aCallback)) {}

  nsCOMPtr<nsIPackageKitProgressCallback> mCallback;
  guint mPropertiesSignalId{0};
};

// ---------------------------------------------------------------------------
// Package-name filter
// ---------------------------------------------------------------------------

static bool IsPackageForThisApp(const gchar* aPackageId) {
  if (!aPackageId) {
    return false;
  }
  nsCOMPtr<nsIXULAppInfo> appInfo =
      do_GetService("@mozilla.org/xre/app-info;1");
  if (!appInfo) {
    return false;
  }
  nsCString remotingName;
  if (NS_FAILED(appInfo->GetRemotingName(remotingName))) {
    return false;
  }
  gchar** tokens = g_strsplit(aPackageId, ";", -1);
  if (!tokens || !tokens[0]) {
    g_strfreev(tokens);
    return false;
  }
  bool matches = (strcmp(tokens[0], remotingName.get()) == 0);
  g_strfreev(tokens);
  return matches;
}

// ---------------------------------------------------------------------------
// Operation-specific signal callbacks
// ---------------------------------------------------------------------------

// "Package" signal: (u info, s package_id, s summary)
static void OnPackageSignal(GDBusConnection*, const gchar*, const gchar*,
                            const gchar*, const gchar*, GVariant* aParameters,
                            gpointer aUserData) {
  auto* state = static_cast<GetUpdatesState*>(aUserData);

  if (!g_variant_is_of_type(aParameters, G_VARIANT_TYPE("(uss)"))) {
    PKDB_LOG(Warning, "Package signal: unexpected type %s",
             g_variant_get_type_string(aParameters));
    return;
  }
  guint32 info = 0;
  const gchar* packageId = nullptr;
  const gchar* summary = nullptr;
  g_variant_get(aParameters, "(u&s&s)", &info, &packageId, &summary);

  if (!packageId || !IsPackageForThisApp(packageId)) {
    PKDB_LOG(Debug, "Package signal: skipped packageId %s", packageId);
    return;
  }
  PackageKitSignalPackage update;
  update.mInfo = info;
  update.mPackageId = packageId;
  update.mSummary = summary ? summary : "";
  state->mResults.AppendElement(std::move(update));
}

// "Packages" signal: (a(uss)) — batched form
static void OnPackagesSignal(GDBusConnection*, const gchar*, const gchar*,
                             const gchar*, const gchar*, GVariant* aParameters,
                             gpointer aUserData) {
  auto* state = static_cast<GetUpdatesState*>(aUserData);

  if (!g_variant_is_of_type(aParameters, G_VARIANT_TYPE("(a(uss))"))) {
    PKDB_LOG(Warning, "Packages signal: unexpected type %s",
             g_variant_get_type_string(aParameters));
    return;
  }
  RefPtr<GVariant> array =
      dont_AddRef(g_variant_get_child_value(aParameters, 0));
  GVariantIter iter;
  g_variant_iter_init(&iter, array);

  guint32 info = 0;
  const gchar* packageId = nullptr;
  const gchar* summary = nullptr;
  while (g_variant_iter_loop(&iter, "(u&s&s)", &info, &packageId, &summary)) {
    if (!packageId || !IsPackageForThisApp(packageId)) {
      PKDB_LOG(Debug, "Packages signal: skipped packageId %s", packageId);
      continue;
    }
    PackageKitSignalPackage update;
    update.mInfo = info;
    update.mPackageId = packageId;
    update.mSummary = summary ? summary : "";
    state->mResults.AppendElement(std::move(update));
  }
}

// "Files" signal: (s package_id, as file_list)
static void OnFilesSignal(GDBusConnection*, const gchar*, const gchar*,
                          const gchar*, const gchar*, GVariant* aParameters,
                          gpointer aUserData) {
  auto* state = static_cast<DownloadPackagesState*>(aUserData);

  if (!g_variant_is_of_type(aParameters, G_VARIANT_TYPE("(sas)"))) {
    PKDB_LOG(Warning, "Files signal: unexpected type %s",
             g_variant_get_type_string(aParameters));
    return;
  }
  const gchar* packageId = nullptr;
  RefPtr<GVariant> fileList =
      dont_AddRef(g_variant_get_child_value(aParameters, 1));
  g_variant_get(aParameters, "(&s@as)", &packageId, nullptr);

  PackageKitSignalFiles files;
  files.mPackageId = packageId ? packageId : "";

  GVariantIter iter;
  g_variant_iter_init(&iter, fileList);
  const gchar* filePath = nullptr;
  while (g_variant_iter_loop(&iter, "&s", &filePath)) {
    PKDB_LOG(Debug, "Files signal: package=%s file=%s", files.mPackageId.get(),
             filePath);
    files.mFileList.AppendElement(nsCString(filePath));
  }
  state->mResults.AppendElement(std::move(files));
}

// Add this callback in the "Operation-specific signal callbacks" section
// "ItemProgress" signal: (s id, u status, u percentage)
template <typename StateType>
static void OnItemProgressSignal(GDBusConnection*, const gchar*, const gchar*,
                                 const gchar*, const gchar*,
                                 GVariant* aParameters, gpointer aUserData) {
  auto* state = static_cast<StateType*>(aUserData);

  if (!g_variant_is_of_type(aParameters, G_VARIANT_TYPE("(suu)"))) {
    PKDB_LOG(Warning, "ItemProgress signal: unexpected type %s",
             g_variant_get_type_string(aParameters));
    return;
  }
  const gchar* id = nullptr;
  guint32 status = 0;
  guint32 percentage = 0;
  g_variant_get(aParameters, "(&suu)", &id, &status, &percentage);

  PackageKitSignalProgress progress;
  progress.mId = id ? id : "";
  progress.mStatus = status;
  progress.mPercentage = percentage;

  // Fire the callback to JS immediately if it was provided
  if (state->mCallback) {
    RefPtr<nsIPackageKitSignalProgress> jsProgress =
        MakeRefPtr<PackageKitSignalProgressResult>(
            progress.mId, progress.mStatus, progress.mPercentage);
    state->mCallback->OnProgress(jsProgress);
  }

  state->mResults.AppendElement(std::move(progress));
}

template <typename StateType>
static void OnStatusChangedSignal(GDBusConnection*, const gchar*, const gchar*,
                                  const gchar*, const gchar*,
                                  GVariant* aParameters, gpointer aUserData) {
  auto* state = static_cast<StateType*>(aUserData);

  if (!g_variant_is_of_type(aParameters, G_VARIANT_TYPE("(u)"))) {
    PKDB_LOG(Warning, "StatusChanged signal: unexpected type");
    return;
  }

  guint32 status;
  g_variant_get(aParameters, "(u)", &status);

  if (state->mCallback) {
    // Pass 101 (PK_PERCENTAGE_INVALID) and an empty string for global status
    // events
    RefPtr<nsIPackageKitSignalProgress> jsProgress =
        MakeRefPtr<PackageKitSignalProgressResult>(""_ns, status, 101);
    state->mCallback->OnProgress(jsProgress);
  }
}

/**
 * Unpacks the transaction-level 'Percentage' property from DBus.Properties
 * changes
 */
template <typename StateType>
static void OnPropertiesChangedSignal(GDBusConnection*, const gchar*,
                                      const gchar*, const gchar*, const gchar*,
                                      GVariant* aParameters,
                                      gpointer aUserData) {
  auto* state = static_cast<StateType*>(aUserData);
  if (!state->mCallback) {
    return;
  }

  RefPtr<GVariant> interface_var =
      dont_AddRef(g_variant_get_child_value(aParameters, 0));
  const gchar* interface_name =
      g_variant_get_string(interface_var.get(), nullptr);

  if (interface_name &&
      strcmp(interface_name, "org.freedesktop.PackageKit.Transaction") == 0) {
    RefPtr<GVariant> changed_properties =
        dont_AddRef(g_variant_get_child_value(aParameters, 1));
    uint32_t percentage = 0;
    if (g_variant_lookup(changed_properties.get(), "Percentage", "u",
                         &percentage)) {
      PKDB_LOG(Debug,
               "PropertiesChanged interceptor: percentage packed successfully "
               "= %u%%",
               percentage);
      RefPtr<nsIPackageKitSignalProgress> jsProgress =
          MakeRefPtr<PackageKitSignalProgressResult>(""_ns, 0, percentage);
      state->mCallback->OnProgress(jsProgress);
    }
  }
}

// ---------------------------------------------------------------------------
// Generic ErrorCode and Finished signal handlers
//
// Each is a template helper called by a typed GDBus callback wrapper below.
// This avoids duplicating the signal handling logic while keeping the GDBus
// C callback interface strongly typed via the cast in each wrapper.
// ---------------------------------------------------------------------------

template <typename StateType>
static void HandleErrorCodeSignal(GDBusConnection* aConnection,
                                  GVariant* aParameters, StateType* aState) {
  guint32 code = 0;
  const gchar* details = nullptr;
  if (g_variant_is_of_type(aParameters, G_VARIANT_TYPE("(us)"))) {
    g_variant_get(aParameters, "(u&s)", &code, &details);
  }
  nsCString errorMsg;
  errorMsg.AppendPrintf("PackageKit error %u: %s", code,
                        details ? details : "(no details)");
  PKDB_LOG(Error, "%s", errorMsg.get());
  aState->UnsubscribeAll(aConnection);
  aState->mPromise->Reject(std::move(errorMsg), __func__);
}

template <typename StateType>
static void HandleFinishedSignal(GDBusConnection* aConnection,
                                 GVariant* aParameters,
                                 UniquePtr<StateType> aState) {
  guint32 exit = 0, runtime = 0;
  if (g_variant_is_of_type(aParameters, G_VARIANT_TYPE("(uu)"))) {
    g_variant_get(aParameters, "(uu)", &exit, &runtime);
  }
  PKDB_LOG(Debug, "PackageKit transaction Finished: exit=%u runtime=%ums", exit,
           runtime);
  aState->UnsubscribeAll(aConnection);
  if (exit == kPKExitSuccess) {
    aState->mPromise->Resolve(std::move(aState->mResults), __func__);
  } else {
    nsCString errorMsg;
    errorMsg.AppendPrintf("PackageKit transaction finished with exit code %u",
                          exit);
    aState->mPromise->Reject(std::move(errorMsg), __func__);
  }
}

// Typed GDBus C callback wrappers — one pair per operation.

static void OnRefreshCacheErrorCodeSignal(GDBusConnection* aConnection,
                                          const gchar*, const gchar*,
                                          const gchar*, const gchar*,
                                          GVariant* aParameters,
                                          gpointer aUserData) {
  HandleErrorCodeSignal(aConnection, aParameters,
                        static_cast<RefreshCacheState*>(aUserData));
}

static void OnRefreshCacheFinishedSignal(GDBusConnection* aConnection,
                                         const gchar*, const gchar*,
                                         const gchar*, const gchar*,
                                         GVariant* aParameters,
                                         gpointer aUserData) {
  HandleFinishedSignal(
      aConnection, aParameters,
      UniquePtr<RefreshCacheState>(static_cast<RefreshCacheState*>(aUserData)));
}

static void OnGetUpdatesErrorCodeSignal(GDBusConnection* aConnection,
                                        const gchar*, const gchar*,
                                        const gchar*, const gchar*,
                                        GVariant* aParameters,
                                        gpointer aUserData) {
  HandleErrorCodeSignal(aConnection, aParameters,
                        static_cast<GetUpdatesState*>(aUserData));
}
static void OnGetUpdatesFinishedSignal(GDBusConnection* aConnection,
                                       const gchar*, const gchar*, const gchar*,
                                       const gchar*, GVariant* aParameters,
                                       gpointer aUserData) {
  HandleFinishedSignal(
      aConnection, aParameters,
      UniquePtr<GetUpdatesState>(static_cast<GetUpdatesState*>(aUserData)));
}
static void OnDownloadPackagesErrorCodeSignal(GDBusConnection* aConnection,
                                              const gchar*, const gchar*,
                                              const gchar*, const gchar*,
                                              GVariant* aParameters,
                                              gpointer aUserData) {
  auto* state = static_cast<DownloadPackagesState*>(aUserData);
  if (state->mPropertiesSignalId) {
    g_dbus_connection_signal_unsubscribe(aConnection,
                                         state->mPropertiesSignalId);
    state->mPropertiesSignalId = 0;
  }
  HandleErrorCodeSignal(aConnection, aParameters, state);
}
static void OnDownloadPackagesFinishedSignal(GDBusConnection* aConnection,
                                             const gchar*, const gchar*,
                                             const gchar*, const gchar*,
                                             GVariant* aParameters,
                                             gpointer aUserData) {
  auto* state = static_cast<DownloadPackagesState*>(aUserData);
  if (state->mPropertiesSignalId) {
    g_dbus_connection_signal_unsubscribe(aConnection,
                                         state->mPropertiesSignalId);
    state->mPropertiesSignalId = 0;
  }
  HandleFinishedSignal(aConnection, aParameters,
                       UniquePtr<DownloadPackagesState>(state));
}

static void OnUpdatePackagesErrorCodeSignal(GDBusConnection* aConnection,
                                            const gchar*, const gchar*,
                                            const gchar*, const gchar*,
                                            GVariant* aParameters,
                                            gpointer aUserData) {
  auto* state = static_cast<UpdatePackagesState*>(aUserData);
  if (state->mPropertiesSignalId) {
    g_dbus_connection_signal_unsubscribe(aConnection,
                                         state->mPropertiesSignalId);
    state->mPropertiesSignalId = 0;
  }
  HandleErrorCodeSignal(aConnection, aParameters, state);
}

static void OnUpdatePackagesFinishedSignal(GDBusConnection* aConnection,
                                           const gchar*, const gchar*,
                                           const gchar*, const gchar*,
                                           GVariant* aParameters,
                                           gpointer aUserData) {
  auto* state = static_cast<UpdatePackagesState*>(aUserData);
  if (state->mPropertiesSignalId) {
    g_dbus_connection_signal_unsubscribe(aConnection,
                                         state->mPropertiesSignalId);
    state->mPropertiesSignalId = 0;
  }
  HandleFinishedSignal(aConnection, aParameters,
                       UniquePtr<UpdatePackagesState>(state));
}

// ---------------------------------------------------------------------------
// SetHints (shared, fire-and-forget)
// ---------------------------------------------------------------------------

static void CallSetHints(RefPtr<GDBusProxy> aProxy, bool aInteractive,
                         GCancellable* aCancellable) {
  const gchar* hints[4];
  hints[0] = "supports-plural-signals=true";
  if (aInteractive) {
    hints[1] = "interactive=true";
    hints[2] = "background=false";
  } else {
    hints[1] = "interactive=false";
    hints[2] = "background=true";
  }
  hints[3] = nullptr;

  GVariant* hintsVariant = g_variant_new_strv(hints, -1);
  DBusProxyCall(aProxy, "SetHints", g_variant_new_tuple(&hintsVariant, 1),
                G_DBUS_CALL_FLAGS_NONE, -1, aCancellable)
      ->Then(
          GetCurrentSerialEventTarget(), __func__,
          [](RefPtr<GVariant>&&) {
            PKDB_LOG(Debug, "PackageKit SetHints succeeded");
          },
          [](GUniquePtr<GError>&& aError) {
            PKDB_LOG(Warning, "PackageKit SetHints failed: %s",
                     aError ? aError->message : "(null)");
          });
}

// ---------------------------------------------------------------------------
// Generic StartTransaction
//
// Handles the plumbing common to every PackageKit transaction:
//   1. Store proxy, extract connection + object path.
//   2. Call aSubscribeSignals to register operation-specific signal handlers.
//   3. Subscribe the shared ErrorCode and Finished handlers.
//   4. Send SetHints (fire-and-forget).
//   5. Call aCallMethod to fire the actual D-Bus method.
//
// SubscribeSignalsFn: void(GDBusConnection*, const gchar* objectPath,
// StateType*) CallMethodFn:       void(RefPtr<GDBusProxy>, GCancellable*,
// StateType*,
//                          GDBusConnection*)
// ---------------------------------------------------------------------------

template <typename StateType, typename SubscribeSignalsFn,
          typename CallMethodFn>
static void StartTransaction(RefPtr<GDBusProxy> aTransactionProxy,
                             UniquePtr<StateType> aState, bool aInteractive,
                             GCancellable* aCancellable,
                             GDBusSignalCallback aErrorCodeCallback,
                             GDBusSignalCallback aFinishedCallback,
                             SubscribeSignalsFn&& aSubscribeSignals,
                             CallMethodFn&& aCallMethod) {
  GDBusConnection* connection = g_dbus_proxy_get_connection(aTransactionProxy);
  const gchar* objectPath = g_dbus_proxy_get_object_path(aTransactionProxy);

  aState->mTransactionProxy = aTransactionProxy;
  StateType* statePtr = aState.get();

  // Subscribe operation-specific signals (Package/Packages or Files).
  aSubscribeSignals(connection, objectPath, statePtr);

  // Subscribe shared ErrorCode signal.
  statePtr->mErrorCodeSignalId = g_dbus_connection_signal_subscribe(
      connection, nullptr, kPKTransactionInterface, "ErrorCode", objectPath,
      nullptr, G_DBUS_SIGNAL_FLAGS_NONE, aErrorCodeCallback, statePtr, nullptr);

  // Subscribe Finished — transfers ownership of state to the callback.
  statePtr->mFinishedSignalId = g_dbus_connection_signal_subscribe(
      connection, nullptr, kPKTransactionInterface, "Finished", objectPath,
      nullptr, G_DBUS_SIGNAL_FLAGS_NONE, aFinishedCallback, aState.release(),
      nullptr);

  // SetHints is fire-and-forget; subscribe calls are already registered.
  CallSetHints(aTransactionProxy, aInteractive, aCancellable);

  // Fire the operation-specific D-Bus method.
  aCallMethod(aTransactionProxy, aCancellable, statePtr, connection);
}

// ---------------------------------------------------------------------------
// StartGetUpdatesTransaction / StartDownloadPackagesTransaction
//
// Thin wrappers over StartTransaction that supply the operation-specific
// signal subscriptions and method calls.
// ---------------------------------------------------------------------------

static void StartRefreshCacheTransaction(RefPtr<GDBusProxy> aTransactionProxy,
                                         UniquePtr<RefreshCacheState> aState,
                                         bool aForce,
                                         GCancellable* aCancellable) {
  StartTransaction(
      std::move(aTransactionProxy), std::move(aState), true, aCancellable,
      OnRefreshCacheErrorCodeSignal, OnRefreshCacheFinishedSignal,
      // Subscribe ItemProgress signal.
      [](GDBusConnection* conn, const gchar* path, RefreshCacheState* state) {
        state->mSignalId1 = g_dbus_connection_signal_subscribe(
            conn, nullptr, kPKTransactionInterface, "ItemProgress", path,
            nullptr, G_DBUS_SIGNAL_FLAGS_NONE,
            OnItemProgressSignal<RefreshCacheState>, state, nullptr);
      },
      // Call RefreshCache(force).
      [aForce](RefPtr<GDBusProxy> proxy, GCancellable* cancellable,
               RefreshCacheState* statePtr, GDBusConnection* connection) {
        PKDB_LOG(Debug, "Calling PackageKit RefreshCache on %s",
                 g_dbus_proxy_get_object_path(proxy));

        DBusProxyCall(
            proxy, "RefreshCache", g_variant_new("(b)", aForce ? TRUE : FALSE),
            G_DBUS_CALL_FLAGS_ALLOW_INTERACTIVE_AUTHORIZATION, -1, cancellable)
            ->Then(
                GetCurrentSerialEventTarget(), __func__,
                [](RefPtr<GVariant>&&) {
                  PKDB_LOG(Debug, "PackageKit RefreshCache call returned");
                },
                [statePtr, connection](GUniquePtr<GError>&& aError) {
                  nsCString err;
                  err.AppendPrintf("PackageKit RefreshCache call failed: %s",
                                   aError ? aError->message : "(null)");
                  PKDB_LOG(Error, "%s", err.get());
                  statePtr->UnsubscribeAll(connection);
                  statePtr->mPromise->Reject(std::move(err), __func__);
                });
      });
}

static void StartGetUpdatesTransaction(RefPtr<GDBusProxy> aTransactionProxy,
                                       UniquePtr<GetUpdatesState> aState,
                                       GCancellable* aCancellable) {
  StartTransaction(
      std::move(aTransactionProxy), std::move(aState), false, aCancellable,
      OnGetUpdatesErrorCodeSignal, OnGetUpdatesFinishedSignal,
      // Subscribe Package (legacy) and Packages (batched) signals.
      [](GDBusConnection* conn, const gchar* path, GetUpdatesState* state) {
        state->mSignalId1 = g_dbus_connection_signal_subscribe(
            conn, nullptr, kPKTransactionInterface, "Package", path, nullptr,
            G_DBUS_SIGNAL_FLAGS_NONE, OnPackageSignal, state, nullptr);
        state->mSignalId2 = g_dbus_connection_signal_subscribe(
            conn, nullptr, kPKTransactionInterface, "Packages", path, nullptr,
            G_DBUS_SIGNAL_FLAGS_NONE, OnPackagesSignal, state, nullptr);
      },
      // Call GetUpdates(filter).
      [](RefPtr<GDBusProxy> proxy, GCancellable* cancellable,
         GetUpdatesState* statePtr, GDBusConnection* connection) {
        PKDB_LOG(Debug, "Calling PackageKit GetUpdates on %s",
                 g_dbus_proxy_get_object_path(proxy));
        DBusProxyCall(proxy, "GetUpdates", g_variant_new("(t)", kPKFilterNone),
                      G_DBUS_CALL_FLAGS_NONE, -1, cancellable)
            ->Then(
                GetCurrentSerialEventTarget(), __func__,
                [](RefPtr<GVariant>&&) {
                  PKDB_LOG(Debug, "PackageKit GetUpdates call returned");
                },
                [statePtr, connection](GUniquePtr<GError>&& aError) {
                  nsCString err;
                  err.AppendPrintf("PackageKit GetUpdates call failed: %s",
                                   aError ? aError->message : "(null)");
                  PKDB_LOG(Error, "%s", err.get());
                  statePtr->UnsubscribeAll(connection);
                  statePtr->mPromise->Reject(std::move(err), __func__);
                });
      });
}

static void StartDownloadPackagesTransaction(
    RefPtr<GDBusProxy> aTransactionProxy,
    UniquePtr<DownloadPackagesState> aState,
    const nsTArray<nsCString>& aPackageIds, GCancellable* aCancellable) {
  StartTransaction(
      std::move(aTransactionProxy), std::move(aState), false, aCancellable,
      OnDownloadPackagesErrorCodeSignal, OnDownloadPackagesFinishedSignal,
      // Subscribe Files signal.
      [](GDBusConnection* conn, const gchar* path,
         DownloadPackagesState* state) {
        state->mSignalId1 = g_dbus_connection_signal_subscribe(
            conn, nullptr, kPKTransactionInterface, "Files", path, nullptr,
            G_DBUS_SIGNAL_FLAGS_NONE, OnFilesSignal, state, nullptr);
        state->mPropertiesSignalId = g_dbus_connection_signal_subscribe(
            conn, nullptr, "org.freedesktop.DBus.Properties",
            "PropertiesChanged", path, nullptr, G_DBUS_SIGNAL_FLAGS_NONE,
            OnPropertiesChangedSignal<DownloadPackagesState>, state, nullptr);
      },
      // Call DownloadPackages(store_in_cache=false, package_ids).
      [aPackageIds = aPackageIds.Clone()](
          RefPtr<GDBusProxy> proxy, GCancellable* cancellable,
          DownloadPackagesState* statePtr, GDBusConnection* connection) {
        PKDB_LOG(Debug, "Calling PackageKit DownloadPackages on %s",
                 g_dbus_proxy_get_object_path(proxy));

        GVariantBuilder builder;
        g_variant_builder_init(&builder, G_VARIANT_TYPE_STRING_ARRAY);
        for (const auto& pkgId : aPackageIds) {
          g_variant_builder_add(&builder, "s", pkgId.get());
        }
        GVariant* variant = g_variant_builder_end(&builder);
        if (!variant) {
          nsCString err(
              "PackageKit DownloadPackages: g_variant_builder_end failure");
          PKDB_LOG(Error, "%s", err.get());
          statePtr->UnsubscribeAll(connection);
          statePtr->mPromise->Reject(std::move(err), __func__);
          return;
        }

        DBusProxyCall(proxy, "DownloadPackages",
                      g_variant_new("(b@as)", false, variant),
                      G_DBUS_CALL_FLAGS_NONE, -1, cancellable)
            ->Then(
                GetCurrentSerialEventTarget(), __func__,
                [](RefPtr<GVariant>&&) {
                  PKDB_LOG(Debug, "PackageKit DownloadPackages call returned");
                },
                [statePtr, connection](GUniquePtr<GError>&& aError) {
                  nsCString err;
                  err.AppendPrintf(
                      "PackageKit DownloadPackages call failed: %s",
                      aError ? aError->message : "(null)");
                  PKDB_LOG(Error, "%s", err.get());
                  statePtr->UnsubscribeAll(connection);
                  statePtr->mPromise->Reject(std::move(err), __func__);
                });
      });
}

static void StartUpdatePackagesTransaction(
    RefPtr<GDBusProxy> aTransactionProxy, UniquePtr<UpdatePackagesState> aState,
    const nsTArray<nsCString>& aPackageIds, GCancellable* aCancellable) {
  StartTransaction(
      std::move(aTransactionProxy), std::move(aState), true, aCancellable,
      OnUpdatePackagesErrorCodeSignal, OnUpdatePackagesFinishedSignal,
      // Subscribe ItemProgress and StatusChanged signals.
      [](GDBusConnection* conn, const gchar* path, UpdatePackagesState* state) {
        state->mSignalId1 = g_dbus_connection_signal_subscribe(
            conn, nullptr, kPKTransactionInterface, "ItemProgress", path,
            nullptr, G_DBUS_SIGNAL_FLAGS_NONE,
            OnItemProgressSignal<UpdatePackagesState>, state, nullptr);
        state->mSignalId2 = g_dbus_connection_signal_subscribe(
            conn, nullptr, kPKTransactionInterface, "StatusChanged", path,
            nullptr, G_DBUS_SIGNAL_FLAGS_NONE,
            OnStatusChangedSignal<UpdatePackagesState>, state, nullptr);
        state->mPropertiesSignalId = g_dbus_connection_signal_subscribe(
            conn, nullptr, "org.freedesktop.DBus.Properties",
            "PropertiesChanged", path, nullptr, G_DBUS_SIGNAL_FLAGS_NONE,
            OnPropertiesChangedSignal<UpdatePackagesState>, state, nullptr);
      },
      // Call UpdatePackages(transaction_flags=0, package_ids).
      [aPackageIds = aPackageIds.Clone()](
          RefPtr<GDBusProxy> proxy, GCancellable* cancellable,
          UpdatePackagesState* statePtr, GDBusConnection* connection) {
        PKDB_LOG(Debug, "Calling PackageKit UpdatePackages on %s",
                 g_dbus_proxy_get_object_path(proxy));

        GVariantBuilder builder;
        g_variant_builder_init(&builder, G_VARIANT_TYPE_STRING_ARRAY);
        for (const auto& pkgId : aPackageIds) {
          g_variant_builder_add(&builder, "s", pkgId.get());
        }
        GVariant* variant = g_variant_builder_end(&builder);
        if (!variant) {
          nsCString err(
              "PackageKit UpdatePackages: g_variant_builder_end failure");
          PKDB_LOG(Error, "%s", err.get());
          statePtr->UnsubscribeAll(connection);
          statePtr->mPromise->Reject(std::move(err), __func__);
          return;
        }

        DBusProxyCall(proxy, "UpdatePackages",
                      g_variant_new("(t@as)", (guint64)0, variant),
                      G_DBUS_CALL_FLAGS_ALLOW_INTERACTIVE_AUTHORIZATION, -1,
                      cancellable)
            ->Then(
                GetCurrentSerialEventTarget(), __func__,
                [](RefPtr<GVariant>&&) {
                  PKDB_LOG(Debug, "PackageKit UpdatePackages call returned");
                },
                [statePtr, connection](GUniquePtr<GError>&& aError) {
                  nsCString err;
                  err.AppendPrintf("PackageKit UpdatePackages call failed: %s",
                                   aError ? aError->message : "(null)");
                  PKDB_LOG(Error, "%s", err.get());
                  statePtr->UnsubscribeAll(connection);
                  statePtr->mPromise->Reject(std::move(err), __func__);
                });
      });
}

// ---------------------------------------------------------------------------
// Generic PackageKitPromise
//
// Handles the D-Bus plumbing common to every PackageKit operation:
//   1. Create a proxy for the main PackageKit service object.
//   2. Call CreateTransaction() to get a transaction object path.
//   3. Create a lightweight transaction proxy (DO_NOT_LOAD_PROPERTIES |
//      DO_NOT_CONNECT_SIGNALS) to avoid well-known-name signal filtering.
//   4. Call aStartTransaction(txProxy, promise, cancellable).
//
// StartTransactionFn: void(RefPtr<GDBusProxy> txProxy,
//                          RefPtr<PromiseType::Private> promise,
//                          GCancellable* cancellable)
// ---------------------------------------------------------------------------

template <typename PromiseType, typename StartTransactionFn>
static RefPtr<PromiseType> PackageKitPromise(
    GCancellable* aCancellable, StartTransactionFn aStartTransaction) {
  auto promise = MakeRefPtr<typename PromiseType::Private>(__func__);

  CreateDBusProxyForBus(G_BUS_TYPE_SYSTEM,
                        G_DBUS_PROXY_FLAGS_DO_NOT_LOAD_PROPERTIES, nullptr,
                        kPKService, kPKObjectPath, kPKInterface, aCancellable)
      ->Then(
          GetCurrentSerialEventTarget(), __func__,
          [promise, aCancellable,
           aStartTransaction = std::move(aStartTransaction)](
              RefPtr<GDBusProxy>&& aMainProxy) mutable {
            PKDB_LOG(
                Debug,
                "PackageKit main proxy created, calling CreateTransaction");

            DBusProxyCall(aMainProxy, "CreateTransaction", nullptr,
                          G_DBUS_CALL_FLAGS_NONE, -1, aCancellable)
                ->Then(
                    GetCurrentSerialEventTarget(), __func__,
                    [promise, aCancellable,
                     aStartTransaction = std::move(aStartTransaction)](
                        RefPtr<GVariant>&& aResult) mutable {
                      if (!g_variant_is_of_type(aResult,
                                                G_VARIANT_TYPE("(o)"))) {
                        nsCString err(
                            "PackageKit CreateTransaction returned "
                            "unexpected type");
                        PKDB_LOG(Error, "%s", err.get());
                        promise->Reject(std::move(err), __func__);
                        return;
                      }
                      const gchar* txPath = nullptr;
                      g_variant_get(aResult, "(&o)", &txPath);
                      PKDB_LOG(Debug, "PackageKit transaction path: %s",
                               txPath);

                      CreateDBusProxyForBus(
                          G_BUS_TYPE_SYSTEM,
                          static_cast<GDBusProxyFlags>(
                              G_DBUS_PROXY_FLAGS_DO_NOT_LOAD_PROPERTIES |
                              G_DBUS_PROXY_FLAGS_DO_NOT_CONNECT_SIGNALS),
                          nullptr, kPKService, txPath, kPKTransactionInterface,
                          aCancellable)
                          ->Then(
                              GetCurrentSerialEventTarget(), __func__,
                              [promise, aCancellable,
                               aStartTransaction =
                                   std::move(aStartTransaction)](
                                  RefPtr<GDBusProxy>&& aTxProxy) mutable {
                                aStartTransaction(std::move(aTxProxy), promise,
                                                  aCancellable);
                              },
                              [promise](GUniquePtr<GError>&& aError) {
                                nsCString err;
                                err.AppendPrintf(
                                    "Failed to create PackageKit transaction "
                                    "proxy: %s",
                                    aError ? aError->message : "(null)");
                                PKDB_LOG(Error, "%s", err.get());
                                promise->Reject(std::move(err), __func__);
                              });
                    },
                    [promise](GUniquePtr<GError>&& aError) {
                      nsCString err;
                      err.AppendPrintf(
                          "PackageKit CreateTransaction failed: %s",
                          aError ? aError->message : "(null)");
                      PKDB_LOG(Error, "%s", err.get());
                      promise->Reject(std::move(err), __func__);
                    });
          },
          [promise](GUniquePtr<GError>&& aError) {
            nsCString err;
            err.AppendPrintf("Failed to create PackageKit main proxy: %s",
                             aError ? aError->message : "(null)");
            PKDB_LOG(Error, "%s", err.get());
            promise->Reject(std::move(err), __func__);
          });

  return promise;
}

// ---------------------------------------------------------------------------
// Public MozPromise API
// ---------------------------------------------------------------------------

RefPtr<PackageKitSignalsProgressPromise>
PackageKitDBusProvider::PackageKitRefreshCache(
    bool aForce, nsIPackageKitProgressCallback* aCallback,
    GCancellable* aCancellable) {
  nsCOMPtr<nsIPackageKitProgressCallback> cb(aCallback);
  return PackageKitPromise<PackageKitSignalsProgressPromise>(
      aCancellable,
      [aForce, cb = std::move(cb)](
          RefPtr<GDBusProxy>&& aTxProxy,
          RefPtr<PackageKitSignalsProgressPromise::Private> aPromise,
          GCancellable* aCancellable) mutable {
        auto state =
            MakeUnique<RefreshCacheState>(std::move(aPromise), std::move(cb));
        StartRefreshCacheTransaction(std::move(aTxProxy), std::move(state),
                                     aForce, aCancellable);
      });
}

RefPtr<PackageKitSignalsPackagePromise>
PackageKitDBusProvider::PackageKitGetUpdates(GCancellable* aCancellable) {
  return PackageKitPromise<PackageKitSignalsPackagePromise>(
      aCancellable,
      [](RefPtr<GDBusProxy>&& aTxProxy,
         RefPtr<PackageKitSignalsPackagePromise::Private> aPromise,
         GCancellable* aCancellable) {
        auto state = MakeUnique<GetUpdatesState>(std::move(aPromise));
        StartGetUpdatesTransaction(std::move(aTxProxy), std::move(state),
                                   aCancellable);
      });
}

RefPtr<PackageKitSignalsFilesPromise>
PackageKitDBusProvider::PackageKitDownloadPackages(
    const nsTArray<nsCString>& aPackageIds,
    nsIPackageKitProgressCallback* aCallback, GCancellable* aCancellable) {
  nsCOMPtr<nsIPackageKitProgressCallback> cb(aCallback);
  return PackageKitPromise<PackageKitSignalsFilesPromise>(
      aCancellable, [aPackageIds = aPackageIds.Clone(), cb = std::move(cb)](
                        RefPtr<GDBusProxy>&& aTxProxy,
                        RefPtr<PackageKitSignalsFilesPromise::Private> aPromise,
                        GCancellable* aCancellable) mutable {
        auto state = MakeUnique<DownloadPackagesState>(std::move(aPromise),
                                                       std::move(cb));
        StartDownloadPackagesTransaction(std::move(aTxProxy), std::move(state),
                                         aPackageIds, aCancellable);
      });
}

RefPtr<PackageKitSignalsProgressPromise>
PackageKitDBusProvider::PackageKitUpdatePackages(
    const nsTArray<nsCString>& aPackageIds,
    nsIPackageKitProgressCallback* aCallback, GCancellable* aCancellable) {
  nsCOMPtr<nsIPackageKitProgressCallback> cb(aCallback);
  return PackageKitPromise<PackageKitSignalsProgressPromise>(
      aCancellable,
      [aPackageIds = aPackageIds.Clone(), cb = std::move(cb)](
          RefPtr<GDBusProxy>&& aTxProxy,
          RefPtr<PackageKitSignalsProgressPromise::Private> aPromise,
          GCancellable* aCancellable) mutable {
        auto state =
            MakeUnique<UpdatePackagesState>(std::move(aPromise), std::move(cb));
        StartUpdatePackagesTransaction(std::move(aTxProxy), std::move(state),
                                       aPackageIds, aCancellable);
      });
}

// ---------------------------------------------------------------------------
// Generic JS Promise builder
//
// Both XPCOM methods resolve a JS Promise with an Array of XPCOM-wrapped
// objects.  BuildJSArrayAndResolve factors out the AutoJSAPI setup,
// NewArrayObject loop, WrapNative, and MaybeResolve/Reject calls.
//
// MakeResultFn: RefPtr<nsISupports>(ResultType&)
// ---------------------------------------------------------------------------

template <typename InterfaceType, typename ResultType, typename MakeResultFn>
static void BuildJSArrayAndResolve(RefPtr<dom::Promise> aJsPromise,
                                   nsTArray<ResultType>&& aResults,
                                   MakeResultFn aMakeResult) {
  dom::AutoJSAPI jsapi;
  if (!jsapi.Init(aJsPromise->GetGlobalObject())) {
    aJsPromise->MaybeReject(NS_ERROR_FAILURE);
    return;
  }
  JSContext* cx = jsapi.cx();

  JS::Rooted<JSObject*> jsArray(cx, JS::NewArrayObject(cx, aResults.Length()));
  if (!jsArray) {
    aJsPromise->MaybeReject(NS_ERROR_OUT_OF_MEMORY);
    return;
  }

  for (uint32_t i = 0; i < aResults.Length(); i++) {
    auto item = aMakeResult(aResults[i]);

    JS::Rooted<JS::Value> val(cx);
    if (NS_WARN_IF(NS_FAILED(nsContentUtils::WrapNative(
            cx, item, &NS_GET_IID(InterfaceType), &val)))) {
      aJsPromise->MaybeReject(NS_ERROR_FAILURE);
      return;
    }
    if (!JS_DefineElement(cx, jsArray, i, val, JSPROP_ENUMERATE)) {
      aJsPromise->MaybeReject(NS_ERROR_FAILURE);
      return;
    }
  }
  aJsPromise->MaybeResolve(jsArray);
}

static already_AddRefed<dom::Promise> CreateJSPromise(JSContext* aCx) {
  nsIGlobalObject* global = xpc::CurrentNativeGlobal(aCx);
  if (NS_WARN_IF(!global)) {
    return nullptr;
  }
  ErrorResult rv;
  RefPtr<dom::Promise> jsPromise = dom::Promise::Create(global, rv);
  if (NS_WARN_IF(rv.Failed())) {
    return nullptr;
  }
  return jsPromise.forget();
}

// ---------------------------------------------------------------------------
// nsIPackageKitDBusProvider implementation
// ---------------------------------------------------------------------------

NS_IMPL_ISUPPORTS(PackageKitDBusProvider, nsIPackageKitDBusProvider)

NS_IMETHODIMP
PackageKitDBusProvider::RefreshCache(bool aForce,
                                     nsIPackageKitProgressCallback* aCallback,
                                     JSContext* aCx, dom::Promise** aPromise) {
  NS_ENSURE_ARG_POINTER(aPromise);
  RefPtr<dom::Promise> jsPromise = CreateJSPromise(aCx);
  if (!jsPromise) {
    return NS_ERROR_FAILURE;
  }

  PackageKitRefreshCache(aForce, aCallback)
      ->Then(
          GetMainThreadSerialEventTarget(), __func__,
          [jsPromise](nsTArray<PackageKitSignalProgress>&& aResults) {
            BuildJSArrayAndResolve<nsIPackageKitSignalProgress>(
                jsPromise, std::move(aResults),
                [](PackageKitSignalProgress& p)
                    -> RefPtr<nsIPackageKitSignalProgress> {
                  return MakeRefPtr<PackageKitSignalProgressResult>(
                      std::move(p.mId), p.mStatus, p.mPercentage);
                });
          },
          [jsPromise](nsCString&& aError) {
            jsPromise->MaybeRejectWithTypeError(aError);
          });

  jsPromise.forget(aPromise);
  return NS_OK;
}

NS_IMETHODIMP
PackageKitDBusProvider::GetUpdates(JSContext* aCx, dom::Promise** aPromise) {
  NS_ENSURE_ARG_POINTER(aPromise);
  RefPtr<dom::Promise> jsPromise = CreateJSPromise(aCx);
  if (!jsPromise) {
    return NS_ERROR_FAILURE;
  }

  PackageKitGetUpdates()->Then(
      GetMainThreadSerialEventTarget(), __func__,
      [jsPromise](nsTArray<PackageKitSignalPackage>&& aResults) {
        BuildJSArrayAndResolve<nsIPackageKitSignalPackage>(
            jsPromise, std::move(aResults),
            [](PackageKitSignalPackage& u)
                -> RefPtr<nsIPackageKitSignalPackage> {
              return MakeRefPtr<PackageKitSignalPackageResult>(
                  u.mInfo, std::move(u.mPackageId), std::move(u.mSummary));
            });
      },
      [jsPromise](nsCString&& aError) {
        jsPromise->MaybeRejectWithTypeError(aError);
      });

  jsPromise.forget(aPromise);
  return NS_OK;
}

NS_IMETHODIMP
PackageKitDBusProvider::DownloadPackages(
    const nsTArray<nsCString>& aPackageIds,
    nsIPackageKitProgressCallback* aCallback, JSContext* aCx,
    dom::Promise** aPromise) {
  NS_ENSURE_ARG_POINTER(aPromise);
  RefPtr<dom::Promise> jsPromise = CreateJSPromise(aCx);
  if (!jsPromise) {
    return NS_ERROR_FAILURE;
  }

  PackageKitDownloadPackages(aPackageIds, aCallback)
      ->Then(
          GetMainThreadSerialEventTarget(), __func__,
          [jsPromise](nsTArray<PackageKitSignalFiles>&& aResults) {
            BuildJSArrayAndResolve<nsIPackageKitSignalFiles>(
                jsPromise, std::move(aResults),
                [](PackageKitSignalFiles& f)
                    -> RefPtr<nsIPackageKitSignalFiles> {
                  return MakeRefPtr<PackageKitSignalFilesResult>(
                      std::move(f.mPackageId), std::move(f.mFileList));
                });
          },
          [jsPromise](nsCString&& aError) {
            jsPromise->MaybeRejectWithTypeError(aError);
          });

  jsPromise.forget(aPromise);
  return NS_OK;
}

NS_IMETHODIMP
PackageKitDBusProvider::UpdatePackages(const nsTArray<nsCString>& aPackageIds,
                                       nsIPackageKitProgressCallback* aCallback,
                                       JSContext* aCx,
                                       dom::Promise** aPromise) {
  NS_ENSURE_ARG_POINTER(aPromise);
  RefPtr<dom::Promise> jsPromise = CreateJSPromise(aCx);
  if (!jsPromise) {
    return NS_ERROR_FAILURE;
  }

  PackageKitUpdatePackages(aPackageIds, aCallback)
      ->Then(
          GetMainThreadSerialEventTarget(), __func__,
          [jsPromise](nsTArray<PackageKitSignalProgress>&& aResults) {
            BuildJSArrayAndResolve<nsIPackageKitSignalProgress>(
                jsPromise, std::move(aResults),
                [](PackageKitSignalProgress& p)
                    -> RefPtr<nsIPackageKitSignalProgress> {
                  return MakeRefPtr<PackageKitSignalProgressResult>(
                      std::move(p.mId), p.mStatus, p.mPercentage);
                });
          },
          [jsPromise](nsCString&& aError) {
            jsPromise->MaybeRejectWithTypeError(aError);
          });

  jsPromise.forget(aPromise);
  return NS_OK;
}

}  // namespace mozilla::dom
