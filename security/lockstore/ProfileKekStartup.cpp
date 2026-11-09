/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "ProfileKekStartup.h"

#include <cstdint>

#include "LockstoreService.h"
#include "ProfileKek.h"
#include "mozilla/AppShutdown.h"
#include "mozilla/IntegerPrintfMacros.h"
#include "mozilla/Logging.h"
#include "mozilla/security/lockstore/lockstore_ffi_generated.h"
#include "mozilla/toolkit/components/felt/felt.h"
#include "nsCOMPtr.h"
#include "nsNSSComponent.h"
#include "nsThreadUtils.h"
#include "secport.h"

namespace mozilla::security::lockstore {

mozilla::LogModule* GetProfileKekLog() {
  static mozilla::LazyLogModule sLog("ProfileKek");
  return sLog;
}

constexpr uint64_t kProfileKekCacheTimeoutMs = UINT64_MAX;

nsCString ProfileKekStartup::sFeltSecret;

ProfileKekStartup::~ProfileKekStartup() = default;

nsresult ProfileKekStartup::CreatePasswordKek(const nsLiteralCString& aKekId,
                                              const nsCString& aPassword) {
  MOZ_ASSERT(!NS_IsMainThread());
  MOZ_ASSERT(mLockstore);
  auto result = mLockstore->DoCreateKek("password"_ns, aKekId, aPassword,
                                        kProfileKekCacheTimeoutMs);
  if (result.isErr()) {
    MOZ_LOG(GetProfileKekLog(), LogLevel::Error,
            ("keystore_create_kek(password:%s) failed: 0x%" PRIx32,
             aKekId.get(), static_cast<uint32_t>(result.unwrapErr())));
    return result.unwrapErr();
  }
  MOZ_LOG(GetProfileKekLog(), LogLevel::Info,
          ("created %s", result.inspect().get()));
  return NS_OK;
}

bool ProfileKekStartup::IsDekWrappedUnder(const nsACString& aDekName,
                                          const nsACString& aKekRef) {
  MOZ_ASSERT(!NS_IsMainThread());
  MOZ_ASSERT(mLockstore);
  auto keks = mLockstore->DoListKeks(aDekName);
  return keks.isOk() && keks.inspect().Contains(aKekRef);
}

Result<nsTArray<nsCString>, nsresult> ProfileKekStartup::DeksWrappedUnder(
    const nsACString& aKekRef) {
  MOZ_ASSERT(!NS_IsMainThread());
  MOZ_ASSERT(mLockstore);
  auto deks = mLockstore->DoListDeks();
  if (deks.isErr()) {
    return Err(deks.unwrapErr());
  }
  nsTArray<nsCString> out;
  for (const auto& dek : deks.inspect()) {
    if (IsDekWrappedUnder(dek, aKekRef)) {
      out.AppendElement(dek);
    }
  }
  return out;
}

nsresult ProfileKekStartup::AddKekToDek(const nsACString& aDekName,
                                        const nsACString& aFromKekRef,
                                        const nsACString& aToKekRef) {
  MOZ_ASSERT(!NS_IsMainThread());
  MOZ_ASSERT(mLockstore);
  if (IsDekWrappedUnder(aDekName, aToKekRef)) {
    return NS_OK;
  }
  return mLockstore->DoAddKek(aDekName, aFromKekRef, aToKekRef);
}

nsresult ProfileKekStartup::DeleteKek(const nsACString& aKekRef) {
  MOZ_ASSERT(!NS_IsMainThread());
  MOZ_ASSERT(mLockstore);
  return mLockstore->DoDeleteKek(aKekRef);
}

nsresult ProfileKekStartup::UnlockOrCreatePasswordKek(
    const nsLiteralCString& aKekRef, const nsLiteralCString& aKekId,
    const nsCString& aPassword) {
  MOZ_ASSERT(!NS_IsMainThread());
  MOZ_ASSERT(mLockstore);
  bool unlocked = false;
  if (NS_SUCCEEDED(mLockstore->IsKekUnlocked(aKekRef, &unlocked)) && unlocked) {
    return NS_OK;
  }
  if (aPassword.IsEmpty()) {
    MOZ_LOG(GetProfileKekLog(), LogLevel::Error,
            ("primarySecret not available; cannot unlock %s", aKekRef.get()));
    return NS_ERROR_NOT_AVAILABLE;
  }

  nsresult rv =
      mLockstore->DoUnlockKek(aKekRef, aPassword, kProfileKekCacheTimeoutMs);
  // INVALID_ARG means the KEK does not exist yet
  if (rv != NS_ERROR_INVALID_ARG) {
    if (NS_FAILED(rv)) {
      MOZ_LOG(GetProfileKekLog(), LogLevel::Error,
              ("keystore_unlock_kek(%s) failed: 0x%" PRIx32, aKekRef.get(),
               static_cast<uint32_t>(rv)));
    }
    return rv;
  }

  MOZ_TRY(CreatePasswordKek(aKekId, aPassword));
  // After creation a KEK should be unlocked. If it isn't it already existed,
  // but in a broken state.
  unlocked = false;
  if (NS_FAILED(mLockstore->IsKekUnlocked(aKekRef, &unlocked)) || !unlocked) {
    MOZ_LOG(GetProfileKekLog(), LogLevel::Error,
            ("%s still locked after create", aKekRef.get()));
    return NS_ERROR_NOT_AVAILABLE;
  }
  return NS_OK;
}

nsresult ProfileKekStartup::RewrapDek(const nsACString& aDekName,
                                      const nsACString& aFromKekRef,
                                      const nsACString& aToKekRef) {
  MOZ_ASSERT(!NS_IsMainThread());
  // Less sensitive than DoMigrateDeks, which doesn't allow some DEKS to
  // already be wrapped by the target
  MOZ_TRY(AddKekToDek(aDekName, aFromKekRef, aToKekRef));
  return mLockstore->DoRemoveKek(aDekName, aFromKekRef);
}

uint32_t ProfileKekStartup::ForEachDekWrappedUnder(
    const nsACString& aKekRef, const char* aWhat,
    FunctionRef<nsresult(const nsCString&)> aOp) {
  MOZ_ASSERT(!NS_IsMainThread());
  auto deks = DeksWrappedUnder(aKekRef);
  if (deks.isErr()) {
    return 0;
  }
  uint32_t succeeded = 0;
  for (const auto& dek : deks.inspect()) {
    nsresult rv = aOp(dek);
    if (NS_FAILED(rv)) {
      MOZ_LOG(GetProfileKekLog(), LogLevel::Warning,
              ("%s: %s failed: 0x%" PRIx32, aWhat, dek.get(),
               static_cast<uint32_t>(rv)));
      continue;
    }
    succeeded++;
  }
  return succeeded;
}

void ProfileKekStartup::BringUpKeks(const nsCString& aSecret) {
  nsresult profileRv =
      UnlockOrCreatePasswordKek(kProfilePasswordKek, kProfileKekId, aSecret);

  if (NS_FAILED(UnlockOrCreatePasswordKek(kSqlitePasswordKek, kSqliteKekId,
                                          aSecret))) {
    return;
  }

  // Profiles predating the Password KEK wrapped their DEKs under a LocalKey.
  auto localDeks = DeksWrappedUnder(kSqliteLocalKek);
  if (localDeks.isOk() && !localDeks.inspect().IsEmpty()) {
    uint32_t moved = ForEachDekWrappedUnder(
        kSqliteLocalKek, "move", [&](const nsCString& aDek) {
          return RewrapDek(aDek, kSqliteLocalKek, kSqlitePasswordKek);
        });
    // Rejected while any DEK still references the KEK; retried next launch.
    nsresult rv = DeleteKek(kSqliteLocalKek);
    MOZ_LOG(GetProfileKekLog(), LogLevel::Info,
            ("move: %u DEKs from %s to %s; deleteKek rv=0x%" PRIx32, moved,
             PromiseFlatCString(kSqliteLocalKek).get(),
             PromiseFlatCString(kSqlitePasswordKek).get(),
             static_cast<uint32_t>(rv)));
  }

  if (NS_SUCCEEDED(profileRv)) {
    uint32_t wrapped = ForEachDekWrappedUnder(
        kSqlitePasswordKek, "wrap", [&](const nsCString& aDek) {
          return AddKekToDek(aDek, kSqlitePasswordKek, kProfilePasswordKek);
        });
    MOZ_LOG(GetProfileKekLog(), LogLevel::Info,
            ("wrap: %u DEKs from %s also under %s", wrapped,
             PromiseFlatCString(kSqlitePasswordKek).get(),
             PromiseFlatCString(kProfilePasswordKek).get()));
  }
}

// static
nsresult ProfileKekStartup::UnlockKekWithSecret(KeystoreHandle* aHandle,
                                                const nsACString& aKekRef) {
  MOZ_ASSERT(!NS_IsMainThread());
  if (!aHandle) {
    return NS_ERROR_INVALID_ARG;
  }
  if (sFeltSecret.IsEmpty()) {
    return NS_ERROR_NOT_AVAILABLE;
  }
  return keystore_unlock_kek(aHandle, &aKekRef, &sFeltSecret,
                             kProfileKekCacheTimeoutMs);
}

// static
void ProfileKekStartup::ClearSecret() {
  MOZ_ASSERT(NS_IsMainThread());
  if (!sFeltSecret.IsEmpty()) {
    PORT_SafeZero(sFeltSecret.BeginWriting(), sFeltSecret.Length());
  }
  sFeltSecret.Truncate();
}

// static
void ProfileKekStartup::BringUpKeksForTesting(LockstoreService* aLockstore,
                                              const nsACString& aSecret) {
  MOZ_ASSERT(!NS_IsMainThread());
  RefPtr<ProfileKekStartup> startup = new ProfileKekStartup();
  startup->mLockstore = aLockstore;
  startup->BringUpKeks(nsCString(aSecret));
}

// static
void ProfileKekStartup::BringUpProfileKeks() {
  MOZ_ASSERT(NS_IsMainThread());
  if (AppShutdown::IsInOrBeyond(ShutdownPhase::XPCOMWillShutdown)) {
    return;
  }
  // The Felt UI process and standalone launches never receive a secret, and
  // storage wraps their DEKs under a LocalKey instead.
  if (!is_felt_browser()) {
    return;
  }
  RefPtr<ProfileKekStartup> self = new ProfileKekStartup();
  self->Run();
}

void ProfileKekStartup::Run() {
  MOZ_ASSERT(NS_IsMainThread());
  // Lockstore needs NSS initialized
  if (!EnsureNSSInitializedChromeOrContent()) {
    NS_WARNING("ProfileKekStartup: NSS init failed");
    return;
  }
  (void)::BlockUntilLoadableCertsLoaded();

  // Creating the service is what caches its profile path, and that only
  // happens on the main thread.
  mLockstore = LockstoreService::GetSingleton();
  if (!mLockstore) {
    return;
  }

  // Felt aborts the launch when it cannot fetch the secret, so an empty one
  // here means there is nothing to unlock and no point blocking below.
  if (sFeltSecret.IsEmpty()) {
    NS_WARNING("ProfileKekStartup: primarySecret not delivered");
    return;
  }

  // The synchronous lockstore tier is forbidden on the main thread, but the
  // KEKs have to be up before we return: the first database open fails closed
  // without them, and the primary-password sync that runs next prompts for a
  // password unless it finds the profile KEK already unlocked. Same wait as
  // SyncProfileKekAtStartup, on its own queue so neither waits on the other's
  // keystore work.
  nsCOMPtr<nsISerialEventTarget> queue;
  if (NS_FAILED(NS_CreateBackgroundTaskQueue("ProfileKekStartup",
                                             getter_AddRefs(queue)))) {
    NS_WARNING("ProfileKekStartup: no task queue to bring the KEKs up on");
    return;
  }
  nsresult rv = NS_DispatchAndSpinEventLoopUntilComplete(
      "ProfileKekStartup::BringUpKeks"_ns, queue,
      NS_NewRunnableFunction(
          "ProfileKekStartup::BringUpKeks",
          [self = RefPtr{this}] { self->BringUpKeks(sFeltSecret); }));
  if (NS_FAILED(rv)) {
    NS_WARNING("ProfileKekStartup: KEK bring-up did not complete");
  }
}

}  // namespace mozilla::security::lockstore

extern "C" void mozSetProfileSecret(const nsACString* aHex) {
  if (!aHex || aHex->IsEmpty()) {
    return;
  }
  // Called on the Felt IPC thread. Copy the characters rather than assigning
  // the string: assignment can share the caller's refcounted buffer, and then
  // ClearSecret would unshare and scrub a copy, leaving the original behind.
  mozilla::security::lockstore::ProfileKekStartup::sFeltSecret.Assign(
      aHex->BeginReading(), aHex->Length());
}
