/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "ProfileKekStartup.h"

#include <cstdint>

#include "LockstoreService.h"
#include "ProfileKek.h"
#include "mozilla/RefPtr.h"
#include "mozilla/Result.h"
#include "mozilla/Services.h"
#include "nsCOMPtr.h"
#include "nsIObserver.h"
#include "nsIObserverService.h"
#include "nsNSSComponent.h"
#include "nsServiceManagerUtils.h"
#include "nsThreadUtils.h"

namespace mozilla::security::lockstore {

mozilla::LogModule* GetProfileKekLog() {
  static mozilla::LazyLogModule sLog("ProfileKek");
  return sLog;
}

NS_IMPL_ISUPPORTS(ProfileKekStartup, nsIObserver)

constexpr uint64_t kProfileKekCacheTimeoutMs = UINT64_MAX;

nsCString ProfileKekStartup::sFeltSecret;

nsresult UnlockPasswordKek(const nsLiteralCString& aKekRef,
                           const nsCString& aPassword) {
  MOZ_ASSERT(!NS_IsMainThread());
  RefPtr<LockstoreService> ls = LockstoreService::GetSingleton();
  if (!ls) {
    return NS_ERROR_NOT_AVAILABLE;
  }
  return ls->DoUnlockKek(aKekRef, aPassword, kProfileKekCacheTimeoutMs);
}

nsresult CreatePasswordKek(const nsLiteralCString& aKekId,
                           const nsCString& aPassword) {
  MOZ_ASSERT(!NS_IsMainThread());
  RefPtr<LockstoreService> ls = LockstoreService::GetSingleton();
  if (!ls) {
    return NS_ERROR_NOT_AVAILABLE;
  }
  auto result = ls->DoCreateKek("password"_ns, aKekId, aPassword,
                                kProfileKekCacheTimeoutMs);
  if (result.isErr()) {
    MOZ_LOG(GetProfileKekLog(), LogLevel::Error,
            ("keystore_create_kek(password:profile) failed: 0x%" PRIx32,
             static_cast<uint32_t>(result.unwrapErr())));
    return result.unwrapErr();
  }
  return NS_OK;
}

nsresult ProfileKekStartup::Init() {
  MOZ_ASSERT(NS_IsMainThread());

  nsCOMPtr<nsIObserverService> os = services::GetObserverService();
  if (os) {
    os->AddObserver(this, "profile-do-change", false);
  }
  return NS_OK;
}

// static
already_AddRefed<ProfileKekStartup> ProfileKekStartup::GetSingleton() {
  nsCOMPtr<nsIObserver> svc =
      do_GetService("@mozilla.org/security/lockstore/profile-kek-startup;1");
  if (!svc) {
    return nullptr;
  }
  // The component is registered as a singleton in components.conf and
  // ProfileKekStartup is the only implementer of this contract ID in tree, so a
  // downcast is safe.
  RefPtr<ProfileKekStartup> startup =
      static_cast<ProfileKekStartup*>(svc.get());
  return startup.forget();
}

NS_IMETHODIMP
ProfileKekStartup::Observe(nsISupports* aSubject, const char* aTopic,
                           const char16_t* aData) {
  if (nsDependentCString(aTopic).EqualsLiteral("profile-do-change")) {
    OnProfileDoChange();
  }
  return NS_OK;
}

void ProfileKekStartup::OnProfileDoChange() {
  MOZ_ASSERT(NS_IsMainThread());

  // Lockstore needs NSS initialized
  if (!EnsureNSSInitializedChromeOrContent()) {
    return;
  }

  // Force lockstore service creation
  RefPtr<LockstoreService> ls = LockstoreService::GetSingleton();

  // Never unlock or create the KEK under an empty password. Felt aborts the
  // launch when it cannot fetch the secret, so an empty one here means there is
  // nothing to unlock.
  if (sFeltSecret.IsEmpty()) {
    return;
  }

  // Off the main thread: the sync Do* tier opens SQLite and runs PBKDF2.
  NS_DispatchBackgroundTask(NS_NewRunnableFunction(
      "ProfileKekStartup::UnlockOrCreateKek", [secret = sFeltSecret]() {
        nsresult rv = UnlockPasswordKek(kProfilePasswordKek, secret);
        // INVALID_ARG means the KEK does not exist yet
        if (rv == NS_ERROR_INVALID_ARG) {
          CreatePasswordKek(kProfileKekId, secret);
        }
      }));
}

}  // namespace mozilla::security::lockstore

extern "C" void mozSetProfileSecret(const nsACString* aHex) {
  if (!aHex || aHex->IsEmpty()) {
    return;
  }
  // Called on the Felt IPC thread.
  mozilla::security::lockstore::ProfileKekStartup::sFeltSecret = *aHex;
}
