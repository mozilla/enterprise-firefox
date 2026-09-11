/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_security_lockstore_ProfileKekStartup_h
#define mozilla_security_lockstore_ProfileKekStartup_h

#include <cstdint>

#include "mozilla/FunctionRef.h"
#include "mozilla/RefPtr.h"
#include "mozilla/Result.h"
#include "nsISupportsImpl.h"
#include "nsString.h"
#include "nsTArray.h"

// Called by the Felt Rust IPC client; hence C linkage.
extern "C" void mozSetProfileSecret(const nsACString* aHex);

namespace mozilla::security::lockstore {

class LockstoreService;
struct KeystoreHandle;

// Brings the profile's two Password KEKs -- profile and sqlite, both keyed by
// the Felt-delivered primarySecret -- up just before profile-do-change is
// fired: the earliest point the keystore can be opened, and ahead of every
// consumer, since the first of them (SQLite at-rest encryption) fails closed
// without the KEKs. Also migrates a profile that predates the Password KEK off
// its LocalKey, and wraps the SQLite DEKs under the profile KEK as well.
//
// Threadsafe-refcounted: the bring-up runs on a background task, so the object
// is addrefed and released off the main thread.
class ProfileKekStartup final {
 public:
  NS_INLINE_DECL_THREADSAFE_REFCOUNTING(ProfileKekStartup)

  // The entry point, called from nsXREDirProvider::DoStartup before the
  // primary-password sync and the profile-do-change notification.
  // Deliberately not an observer: observers are notified in reverse
  // registration order, so no registration point can guarantee running ahead
  // of every consumer. Blocks the main thread until the KEKs are up.
  // Main-thread only.
  static void BringUpProfileKeks();

  // Takes a raw handle because it targets a keystore other than the profile's
  // own: the source profile of a Profile Refresh, which shares the secret.
  // Off-main-thread only, like the rest of the synchronous keystore tier.
  static nsresult UnlockKekWithSecret(KeystoreHandle* aHandle,
                                      const nsACString& aKekRef);

  // Drops the Felt secret. Called by LockstoreService at xpcom-will-shutdown,
  // under the lock that serialises UnlockKekWithSecret, so no unlock can be
  // reading it. Main-thread only.
  static void ClearSecret();

  // Runs the bring-up that profile-do-change would run, against a
  // caller-supplied service and secret so a test does not need a Felt launch.
  // Off-main-thread only.
  static void BringUpKeksForTesting(LockstoreService* aLockstore,
                                    const nsACString& aSecret);

 private:
  ProfileKekStartup() = default;
  ~ProfileKekStartup();

  friend void ::mozSetProfileSecret(const nsACString* aHex);

  // The Felt-delivered primarySecret. Written exactly once, before any reader
  // exists, so it needs no lock -- re-verified end to end, do not re-litigate:
  //   * FeltProcessParent.startFirefox() calls sendPrimarySecret() once per
  //     launch, ahead of every other message including StartupReady;
  //   * the client's ipc_loop handles messages in order, so the write here
  //     precedes its StartupReady handling, which hops to the main thread and
  //     releases the startup barrier;
  //   * XRE_mainRun spins on that barrier (acquire) before it reaches
  //     mDirProvider.DoStartup(), which is what fires profile-do-change.
  // Both readers -- the KEK bring-up and the Profile Refresh rewrap -- run
  // after that. A second or late delivery would need a lock.
  static nsCString sFeltSecret;

  // Resolves the keystore, then blocks on the background bring-up.
  void Run();

  // These assert on mLockstore rather than check it; Run bails before it can
  // reach them.
  bool IsKekUnlocked(const nsACString& aKekRef);
  bool IsDekWrappedUnder(const nsACString& aDekName, const nsACString& aKekRef);
  Result<nsTArray<nsCString>, nsresult> DeksWrappedUnder(
      const nsACString& aKekRef);
  nsresult UnlockPasswordKek(const nsLiteralCString& aKekRef,
                             const nsCString& aPassword);
  nsresult CreatePasswordKek(const nsLiteralCString& aKekId,
                             const nsCString& aPassword);
  nsresult AddKekToDek(const nsACString& aDekName,
                       const nsACString& aFromKekRef,
                       const nsACString& aToKekRef);
  nsresult DeleteKek(const nsACString& aKekRef);

  nsresult UnlockOrCreatePasswordKek(const nsLiteralCString& aKekRef,
                                     const nsLiteralCString& aKekId,
                                     const nsCString& aPassword);
  nsresult RewrapDek(const nsACString& aDekName, const nsACString& aFromKekRef,
                     const nsACString& aToKekRef);

  // |aWhat| tags the per-DEK failure log. Failures are skipped rather than
  // propagated so one bad DEK cannot strand the rest; returns how many
  // succeeded.
  uint32_t ForEachDekWrappedUnder(const nsACString& aKekRef, const char* aWhat,
                                  FunctionRef<nsresult(const nsCString&)> aOp);

  void RewrapAllDeks(const nsACString& aFromKekRef,
                     const nsACString& aToKekRef);
  void AlsoWrapAllDeksUnder(const nsACString& aFromKekRef,
                            const nsACString& aToKekRef);
  void BringUpKeks(const nsCString& aSecret);

  // Creating the service is what caches its profile path, so it is resolved on
  // the main thread in BringUpProfileKeks rather than from the background task.
  RefPtr<LockstoreService> mLockstore;
};

}  // namespace mozilla::security::lockstore

#endif  // mozilla_security_lockstore_ProfileKekStartup_h
