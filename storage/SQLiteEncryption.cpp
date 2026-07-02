/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/storage/SQLiteEncryption.h"

#include "mozilla/AppShutdown.h"
#include "mozilla/Hex.h"
#include "mozilla/Logging.h"
#include "mozilla/Services.h"
#include "mozilla/StaticMutex.h"
#include "mozilla/StaticPtr.h"
#include "mozilla/StaticPrefs_security.h"
#include "mozilla/SpinEventLoopUntil.h"
#include "mozilla/SyncRunnable.h"
#include "mozilla/TimeStamp.h"
#include "mozilla/dom/quota/IPCStreamCipherStrategy.h"
#include "mozilla/security/lockstore/lockstore_ffi_generated.h"
#if defined(MOZ_ENTERPRISE)
#  include "mozilla/toolkit/components/felt/felt.h"
#endif
#include "ScopedNSSTypes.h"
#include "nsAppDirectoryServiceDefs.h"
#include "nsAppRunner.h"
#include "nsCOMPtr.h"
#include "nsDirectoryServiceDefs.h"
#include "nsDirectoryServiceUtils.h"
#include "nsIFile.h"
#include "nsIInputStream.h"
#include "nsIObserver.h"
#include "nsIObserverService.h"
#include "nsLocalFile.h"
#include "nsNetUtil.h"
#include "nsServiceManagerUtils.h"
#include "nsString.h"
#include "nsTArray.h"
#include "nsThreadUtils.h"

namespace mozilla::storage {

mozilla::LogModule* GetSQLiteEncryptionLog() {
  static mozilla::LazyLogModule sLog("SQLiteEncryption");
  return sLog;
}

namespace {

using mozilla::security::lockstore::keystore_add_kek;
using mozilla::security::lockstore::keystore_close;
using mozilla::security::lockstore::keystore_create_dek;
using mozilla::security::lockstore::keystore_create_kek;
using mozilla::security::lockstore::keystore_delete_kek;
using mozilla::security::lockstore::keystore_get_dek;
using mozilla::security::lockstore::keystore_import_dek;
using mozilla::security::lockstore::keystore_is_kek_unlocked;
using mozilla::security::lockstore::keystore_list_deks;
using mozilla::security::lockstore::keystore_list_keks;
using mozilla::security::lockstore::keystore_open;
using mozilla::security::lockstore::keystore_remove_kek;
using mozilla::security::lockstore::keystore_switch_kek;
using mozilla::security::lockstore::keystore_unlock_kek;
using mozilla::security::lockstore::KeystoreHandle;

// Deterministic kek_ref literals (the random-suffix in
// `lockstore::kek::<type>:<id>`) for the two KEKs the storage layer
// owns. Defined as string literals; consumers wrap them in a local
// `nsCString` before passing &-of to the FFI (which expects
// `const nsACString*`, not the more-derived `nsLiteralCString*`).
#define KEK_REF_LOCAL_SQLITE "lockstore::kek::local:sqlite"
#define KEK_REF_PASSWORD_SQLITE "lockstore::kek::password:sqlite"

// Practical max for cache_timeout_ms; "session-unlimited". Lockstore's
// 0 means "don't cache" (zero-and-discard), not "infinity".
// u32::MAX ms == ~49.7 days; if a session ever runs that long, the
// re-unlock path in GetEncryptionKey transparently re-derives.
constexpr uint32_t kKekCacheTimeoutMs = UINT32_MAX;

constexpr size_t kDekBytes = 32;

// The lockstore-minted DEK is consumed directly as the
// page-encryption cipher's symmetric key in obfsvfs. The cipher's
// `KeyType` is the load-bearing definition of how many bytes that
// requires; pin `kDekBytes` to it so any cipher migration (or a
// change to lockstore that mints a different-sized key) breaks the
// build instead of producing a silently truncated / padded cipher
// key at runtime. This is the storage-side counterpart to the
// explicit `key_size` argument now threaded through
// `keystore_create_dek`.
static_assert(kDekBytes ==
                  sizeof(mozilla::dom::quota::IPCStreamCipherStrategy::KeyType),
              "kDekBytes must match the page-encryption cipher's KeyType size; "
              "update kDekBytes (and the keystore_create_dek call sites that "
              "pass it) in lockstep with any cipher key-length change.");

mozilla::StaticMutex sStateMutex;
KeystoreHandle* sHandle MOZ_GUARDED_BY(sStateMutex) = nullptr;
nsString sCachedProfilePath MOZ_GUARDED_BY(sStateMutex);
// Cached handle to the SOURCE profile's keystore during a Profile Refresh.
// Opened once and reused for every copied database's DEK transfer, then closed
// at shutdown. lockstore caches keystores via a Weak ref that self-evicts when
// the last Arc drops, so closing the source handle after each collection would
// force a re-open of the source SQLite for the next collection (which fails);
// keeping one strong handle alive lets every DEK transfer from the same source.
KeystoreHandle* sRefreshSrcHandle MOZ_GUARDED_BY(sStateMutex) = nullptr;
nsCString sRefreshSrcPath MOZ_GUARDED_BY(sStateMutex);
// Deterministic kek_ref under which every SQLite DEK is wrapped.
// `lockstore::kek::password:sqlite` (a Password KEK with
// primarySecret as the password); the legacy
// `lockstore::kek::local:sqlite` value is migrated away at first
// launch. Resolved lazily via the unlock-or-create flow in
// GetEncryptionKey.
nsCString sKekRef MOZ_GUARDED_BY(sStateMutex);
// Console-supplied primarySecret (64-char hex), cached for the
// lifetime of the session. Delivered by the Felt IPC bridge during early
// profile startup; EnsurePrimarySecretCached waits for it (it can run from
// either profile-do-change or profile-after-change, whichever opens the first
// encrypted database). Consumed by the Password KEK unlock/create call and by
// the transparent re-unlock path after cache expiry. Held in the same
// StaticMutex lifecycle as sHandle so it survives across background-thread DB
// opens. Cleared on xpcom-will-shutdown.
nsCString sPrimarySecret MOZ_GUARDED_BY(sStateMutex);
// Set once xpcom-will-shutdown has torn the keystore down, so later calls
// don't re-open it or mint key material that would never be destroyed.
bool sShuttingDown MOZ_GUARDED_BY(sStateMutex) = false;
// Set if writing the EncryptedDatabases marker to compatibility.ini failed.
// While set, GetEncryptionKey refuses to mint a DEK for a NEW database, so we
// never create encrypted data the launch guard cannot later protect. The
// marker write is retried on every startup, so a transient failure self-heals.
bool sMarkerWriteFailed MOZ_GUARDED_BY(sStateMutex) = false;

class ProfileObserver final : public nsIObserver {
 public:
  NS_DECL_THREADSAFE_ISUPPORTS
  NS_DECL_NSIOBSERVER
 private:
  ~ProfileObserver() = default;
};

mozilla::StaticRefPtr<ProfileObserver> sObserver;

NS_IMPL_ISUPPORTS(ProfileObserver, nsIObserver)

// The Password KEK is keyed by the Felt-delivered primarySecret, which only
// exists in enterprise (Felt) builds, so compile this waiter out elsewhere -- it
// would otherwise be an unused function (its sole caller is already gated on
// MOZ_ENTERPRISE).
#if defined(MOZ_ENTERPRISE)
// Wait for the console-supplied primarySecret to be delivered by the Felt IPC
// bridge. The Felt parent process fetches primarySecret before spawning the
// browsing Firefox and sends it as its first IPC message; the spawned child's
// FeltClientThread pushes it straight into sPrimarySecret via the
// mozStorageSetSqlitePrimarySecret entry point (below) -- it is never stored on
// the Felt side. This call blocks until that delivery happens.
//
// The browser cannot decrypt its profile without primarySecret, so wait
// generously and then fail closed (no plaintext fallback). The Felt parent
// already aborts the launch when its own getPrimarySecret() fetch fails, so a
// non-arrival here is not expected in practice.
//
// Returns NS_OK once delivered, NS_ERROR_NOT_AVAILABLE on timeout or shutdown.
nsresult EnsurePrimarySecretCached() {
  MOZ_ASSERT(NS_IsMainThread());
  constexpr uint32_t kTimeoutMs = 30000;
  const TimeStamp deadline =
      TimeStamp::Now() + TimeDuration::FromMilliseconds(kTimeoutMs);
  // Spin the event loop rather than blocking the main thread with a sleep, the
  // same way the Felt startup barrier waits in nsAppRunner: keep IPC and other
  // main-thread work running while we wait for Felt to deliver the secret. Stop
  // on delivery, shutdown, or the timeout.
  SpinEventLoopUntil("storage::EnsurePrimarySecretCached"_ns, [&]() -> bool {
    {
      StaticMutexAutoLock lock(sStateMutex);
      if (!sPrimarySecret.IsEmpty() || sShuttingDown) {
        return true;
      }
    }
    return TimeStamp::Now() >= deadline;
  });
  StaticMutexAutoLock lock(sStateMutex);
  if (!sPrimarySecret.IsEmpty()) {
    return NS_OK;
  }
  // Timed out or shutting down: fail closed, no plaintext fallback.
  MOZ_LOG(GetSQLiteEncryptionLog(), LogLevel::Error,
          ("primarySecret not delivered by Felt (timeout or shutdown); failing "
           "closed"));
  return NS_ERROR_NOT_AVAILABLE;
}
#endif  // MOZ_ENTERPRISE

// One-shot migration. Called at most once per profile, from the
// create branch of GetEncryptionKey. Rotates every DEK currently
// wrapped under `lockstore::kek::local:sqlite` to instead be wrapped
// under `lockstore::kek::password:sqlite`, then deletes the now-orphan
// LocalKey record. Idempotent: on a true-fresh profile there's no
// local:sqlite to rotate and this is a no-op.
//
// Caller must hold sStateMutex.
nsresult MigrateLocalToPasswordKek() {
  sStateMutex.AssertCurrentThreadOwns();
  MOZ_LOG(GetSQLiteEncryptionLog(), LogLevel::Info,
          ("Migrating local:sqlite -> password:sqlite"));
  const nsCString localKek(KEK_REF_LOCAL_SQLITE ""_ns);
  const nsCString passwordKek(KEK_REF_PASSWORD_SQLITE ""_ns);
  nsTArray<nsCString> collections;
  nsresult rv = keystore_list_deks(sHandle, &collections);
  if (NS_FAILED(rv)) {
    return rv;
  }
  uint32_t rotated = 0;
  for (const auto& coll : collections) {
    nsTArray<nsCString> keks;
    if (NS_FAILED(keystore_list_keks(sHandle, &coll, &keks))) {
      continue;
    }
    bool hasLocal = false;
    for (const auto& k : keks) {
      if (k.Equals(localKek)) {
        hasLocal = true;
        break;
      }
    }
    if (!hasLocal) {
      continue;
    }
    // Add the password wrapping, switch primary to it, drop the
    // local wrapping. Each step independently fallible; log and
    // move on so a single bad collection doesn't strand the rest.
    nsresult ar = keystore_add_kek(sHandle, &coll, &localKek, &passwordKek);
    if (NS_FAILED(ar)) {
      MOZ_LOG(GetSQLiteEncryptionLog(), LogLevel::Warning,
              ("migrate: add_kek failed for %s: 0x%" PRIx32, coll.get(),
               static_cast<uint32_t>(ar)));
      continue;
    }
    nsresult sr = keystore_switch_kek(sHandle, &coll, &localKek, &passwordKek);
    if (NS_FAILED(sr)) {
      MOZ_LOG(GetSQLiteEncryptionLog(), LogLevel::Warning,
              ("migrate: switch_kek failed for %s: 0x%" PRIx32, coll.get(),
               static_cast<uint32_t>(sr)));
      continue;
    }
    nsresult rr = keystore_remove_kek(sHandle, &coll, &localKek);
    if (NS_FAILED(rr)) {
      MOZ_LOG(GetSQLiteEncryptionLog(), LogLevel::Warning,
              ("migrate: remove_kek failed for %s: 0x%" PRIx32, coll.get(),
               static_cast<uint32_t>(rr)));
      continue;
    }
    rotated++;
  }
  // After all collections are rotated, drop the LocalKey record
  // entirely. Lockstore's in-use guard rejects this if any
  // collection slipped through above; in that case the LocalKey
  // record survives and PruneOrphanLocalKekLocked re-attempts the
  // delete on the steady-state unlock path on a later launch (this
  // function only runs the once, when the Password KEK is minted).
  nsresult dr = keystore_delete_kek(sHandle, &localKek);
  if (NS_FAILED(dr)) {
    MOZ_LOG(GetSQLiteEncryptionLog(), LogLevel::Warning,
            ("migrate: delete_kek(local:sqlite) failed: 0x%" PRIx32
             " (will retry on next launch)",
             static_cast<uint32_t>(dr)));
  } else {
    MOZ_LOG(GetSQLiteEncryptionLog(), LogLevel::Info,
            ("Migrated %u collections; local:sqlite deleted", rotated));
  }
  return NS_OK;
}

// Best-effort prune of the orphan LocalKey after every DEK has been
// rotated to the Password KEK. MigrateLocalToPasswordKek (above) is the
// primary deleter, but it runs only once -- when the Password KEK is
// first minted -- and is never re-invoked once that KEK exists, so a
// delete that failed there (or a profile migrated by an older build)
// would otherwise strand local:sqlite forever. The steady-state unlock
// path calls this once per session, making the cleanup self-healing.
// keystore_delete_kek is rejected by lockstore's in-use guard while
// local:sqlite still wraps any collection, so this is a safe no-op until
// the key is genuinely orphaned. Caller holds sStateMutex.
void PruneOrphanLocalKekLocked() {
  sStateMutex.AssertCurrentThreadOwns();
  const nsCString localKek(KEK_REF_LOCAL_SQLITE ""_ns);
  if (NS_SUCCEEDED(keystore_delete_kek(sHandle, &localKek))) {
    MOZ_LOG(GetSQLiteEncryptionLog(), LogLevel::Info,
            ("Pruned orphan local:sqlite KEK (post-migration cleanup)"));
  }
}

// Resolve the profile directory and cache it. MAIN-THREAD ONLY:
// NS_GetSpecialDirectory -> nsDirectoryService::Get asserts NS_IsMainThread()
// ("Do not call dirsvc::get on non-main threads!") and, in opt builds where
// the assert is compiled out, races its internal hashtable against the main
// thread. Off-main-thread callers must go through
// EnsureProfilePathCachedAnyThread() instead.
void EnsureProfilePathCached() {
  MOZ_ASSERT(NS_IsMainThread());
  nsCOMPtr<nsIFile> profileDir;
  nsresult rv = NS_GetSpecialDirectory(NS_APP_USER_PROFILE_50_DIR,
                                       getter_AddRefs(profileDir));
  if (NS_FAILED(rv) || !profileDir) {
    return;
  }
  nsString path;
  if (NS_FAILED(profileDir->GetPath(path)) || path.IsEmpty()) {
    return;
  }
  StaticMutexAutoLock lock(sStateMutex);
  sCachedProfilePath = path;
  MOZ_LOG(GetSQLiteEncryptionLog(), LogLevel::Info, ("Profile path cached"));
}

// Ensure the profile path is cached; callable from any thread. Database opens
// run on worker threads (e.g. the QuotaManager / IndexedDB IO threads) where
// the directory service is unavailable, so off the main thread we bounce a
// tiny runnable to the main thread to resolve and cache the path. This is the
// safe direction (worker -> main): the main thread never blocks waiting on a
// storage IO thread, so it cannot deadlock. The fast path avoids the dispatch
// once the path is cached (which, after the first open, it always is).
void EnsureProfilePathCachedAnyThread() {
  {
    StaticMutexAutoLock lock(sStateMutex);
    if (!sCachedProfilePath.IsEmpty()) {
      return;
    }
  }
  if (NS_IsMainThread()) {
    EnsureProfilePathCached();
    return;
  }
  nsCOMPtr<nsIRunnable> r =
      NS_NewRunnableFunction("mozilla::storage::EnsureProfilePathCached",
                             []() { EnsureProfilePathCached(); });
  mozilla::SyncRunnable::DispatchToThread(GetMainThreadSerialEventTarget(), r);
}

// Snapshot the cached profile path, resolving and caching it on first use.
// Runs on whatever thread opened the database (often a worker such as the
// QuotaManager IO thread, which can open DBs before the main-thread eager
// cache or profile-after-change has populated it -- and under xpcshell
// profile-after-change never fires at all). dirsvc is main-thread only, so
// EnsureProfilePathCachedAnyThread bounces to the main thread when called from
// a worker rather than resolving (and crashing) here. Returns
// NS_ERROR_NOT_INITIALIZED if the path still cannot be resolved.
nsresult GetCachedProfilePath(nsString& aOutPath) {
  {
    StaticMutexAutoLock lock(sStateMutex);
    aOutPath = sCachedProfilePath;
  }
  if (aOutPath.IsEmpty()) {
    EnsureProfilePathCachedAnyThread();
    StaticMutexAutoLock lock(sStateMutex);
    aOutPath = sCachedProfilePath;
  }
  if (aOutPath.IsEmpty()) {
    MOZ_LOG(GetSQLiteEncryptionLog(), LogLevel::Warning,
            ("Profile path not yet cached"));
    return NS_ERROR_NOT_INITIALIZED;
  }
  return NS_OK;
}

// If the encryption pref is on, mark the running profile's compatibility.ini
// with EncryptedDatabases=1 (append-only; the writer skips if already
// present), so a later launch can refuse to open the now-encrypted databases
// under a build that would treat them as plaintext. Safe to call on every
// profile-after-change.
void MarkProfileEncryptedIfNeeded() {
  MOZ_ASSERT(NS_IsMainThread());
  if (!StaticPrefs::security_storage_encryption_sqlite_enabled()) {
    return;
  }
  nsresult rv = mozilla::MarkProfileEncryptedDatabases();
  if (NS_FAILED(rv)) {
    // The launch guard relies on this marker to refuse opening the profile
    // under a build that would treat the now-encrypted databases as plaintext.
    // If we cannot write it, refuse to create new encrypted data (see
    // sMarkerWriteFailed in GetEncryptionKey) rather than silently produce
    // ciphertext the guard can't protect. Retried on every startup.
    MOZ_LOG(GetSQLiteEncryptionLog(), LogLevel::Error,
            ("Failed to write EncryptedDatabases marker (0x%" PRIx32
             "); refusing to encrypt new databases this session",
             static_cast<uint32_t>(rv)));
    StaticMutexAutoLock lock(sStateMutex);
    sMarkerWriteFailed = true;
  }
}

// When SQLite encryption is on, NSS must be fully initialized on the MAIN
// thread before any in-profile database is opened on a worker (the
// QuotaManager / IndexedDB IO threads). Otherwise the worker's
// EnsureNSSInitializedChromeOrContent() SyncRunnable-dispatches NSS init back
// to the main thread and blocks -- which deadlocks when the main thread is
// itself blocked awaiting that very storage operation (e.g. a synchronous
// LocalStorage/QuotaManager op spinning a nested event loop). Initializing NSS
// here, on the main thread, makes that worker call a cheap no-op (NSS init is
// an idempotent process-wide one-shot). Gated on the profile path being known
// (NSS needs cert9.db/key4.db; forcing it earlier brings NSS up via
// NSS_NoDB_Init and breaks PSM) and MAIN-THREAD ONLY (so this can never itself
// be the deadlocking worker->main dispatch).
void EnsureNSSInitializedForEncryptionIfReady() {
  MOZ_ASSERT(NS_IsMainThread());
  if (!StaticPrefs::security_storage_encryption_sqlite_enabled()) {
    return;
  }
  {
    StaticMutexAutoLock lock(sStateMutex);
    if (sCachedProfilePath.IsEmpty()) {
      return;
    }
  }
  (void)EnsureNSSInitializedChromeOrContent();
}

// Ensure the (destination/runtime) keystore handle is open against
// |aProfilePathUtf8| and the shared SQLite KEK (sKekRef) is resolved for this
// process's Felt tier: the spawned browsing Firefox gets a Password KEK keyed
// by primarySecret, the Felt UI process and non-Felt/dev builds (and CI under
// MOZ_BYPASS_FELT) get a LocalKey. Caller MUST hold sStateMutex and have
// checked sShuttingDown. Shared by GetEncryptionKey and the Refresh re-wrap so
// both wrap DEKs under the identical KEK this process will present at runtime.
nsresult EnsureKeystoreAndKekLocked(const nsACString& aProfilePathUtf8) {
  sStateMutex.AssertCurrentThreadOwns();

  if (!sHandle) {
    nsresult rv = keystore_open(&aProfilePathUtf8, &sHandle);
    if (NS_FAILED(rv)) {
      MOZ_LOG(GetSQLiteEncryptionLog(), LogLevel::Error,
              ("keystore_open failed: 0x%" PRIx32, static_cast<uint32_t>(rv)));
      return rv;
    }
    MOZ_LOG(GetSQLiteEncryptionLog(), LogLevel::Info, ("Lockstore opened"));
  }

  if (sKekRef.IsEmpty()) {
#if defined(MOZ_ENTERPRISE)
    const bool isFeltSpawnedBrowser = is_felt_browser();
#else
    const bool isFeltSpawnedBrowser = false;
#endif

    if (isFeltSpawnedBrowser) {
      // Spawned browsing Firefox -- Password KEK keyed by primarySecret.
      // Unlock-or-create.
      if (sPrimarySecret.IsEmpty()) {
        MOZ_LOG(GetSQLiteEncryptionLog(), LogLevel::Error,
                ("primarySecret not cached; cannot bootstrap Password KEK"));
        return NS_ERROR_NOT_AVAILABLE;
      }
      const nsCString passwordKek(KEK_REF_PASSWORD_SQLITE ""_ns);
      nsresult urv = keystore_unlock_kek(sHandle, &passwordKek, &sPrimarySecret,
                                         kKekCacheTimeoutMs);
      if (NS_SUCCEEDED(urv)) {
        sKekRef = passwordKek;
        MOZ_LOG(GetSQLiteEncryptionLog(), LogLevel::Info,
                ("Password KEK unlocked (steady state)"));
        // Self-healing cleanup: drop a LocalKey orphaned by a prior
        // migration whose delete step did not complete (runs once per
        // session via the sKekRef.IsEmpty() guard).
        PruneOrphanLocalKekLocked();
      } else if (urv == NS_ERROR_NOT_AVAILABLE || urv == NS_ERROR_INVALID_ARG) {
        // No KEK row yet (first-ever launch) -- mint it (idempotent).
        const nsCString kekType("password"_ns);
        const nsCString kekId("sqlite"_ns);
        nsCString minted;
        nsresult crv =
            keystore_create_kek(sHandle, &kekType, &kekId, &sPrimarySecret,
                                kKekCacheTimeoutMs, &minted);
        if (NS_FAILED(crv)) {
          MOZ_LOG(GetSQLiteEncryptionLog(), LogLevel::Error,
                  ("keystore_create_kek(password:sqlite) failed: 0x%" PRIx32,
                   static_cast<uint32_t>(crv)));
          return crv;
        }
        sKekRef = minted;
        MOZ_LOG(GetSQLiteEncryptionLog(), LogLevel::Info,
                ("Password KEK created: %s", sKekRef.get()));
        // First-ever-create: rotate any pre-existing local:sqlite wrappings to
        // the new Password KEK and drop the LocalKey record. No-op on a truly
        // fresh profile.
        (void)MigrateLocalToPasswordKek();
      } else {
        MOZ_LOG(GetSQLiteEncryptionLog(), LogLevel::Error,
                ("keystore_unlock_kek(password:sqlite) failed: 0x%" PRIx32,
                 static_cast<uint32_t>(urv)));
        return urv;
      }
    } else {
      // Felt UI process / non-Felt build / CI (MOZ_BYPASS_FELT): LocalKey.
      // create_kek with a fixed identifier is get-or-create.
      const nsCString kekType("local"_ns);
      const nsCString kekId("sqlite"_ns);
      const nsCString empty;
      nsresult crv = keystore_create_kek(sHandle, &kekType, &kekId, &empty,
                                         /* cache_timeout_ms */ 0, &sKekRef);
      if (NS_FAILED(crv)) {
        sKekRef.Truncate();
        MOZ_LOG(GetSQLiteEncryptionLog(), LogLevel::Error,
                ("keystore_create_kek(local:sqlite) failed: 0x%" PRIx32,
                 static_cast<uint32_t>(crv)));
        return crv;
      }
      MOZ_LOG(GetSQLiteEncryptionLog(), LogLevel::Info,
              ("LocalKey KEK in use (Felt UI / non-Felt build): %s",
               sKekRef.get()));
    }
  }
  return NS_OK;
}

// Lazy "Refresh Firefox" DEK recovery. A refresh copies the source profile's
// at-rest-encrypted databases into this new profile, but their per-database
// DEKs live in the SOURCE profile's keystore and this profile's own
// (per-profile random) KEK cannot unwrap them. When such a copied, existing
// database is first opened here and its DEK is missing, the migrator's on-disk
// marker `<profile>/.sqlite-refresh-source` (the source profile path -- the
// only channel that survives the reset's migration->browser boundary) lets us
// transfer just that database's DEK from the source keystore, re-wrapped under
// this profile's own KEK, and read it. The source profile is still on disk at
// this point (the reset's file deletion is a deferred background task). Never
// copies the source keystore (its LocalKey is foreign). Caller holds
// sStateMutex and has resolved sHandle + sKekRef. Returns NS_OK with aOutDek
// filled on success, or NS_ERROR_NOT_AVAILABLE (no marker / no source DEK /
// etc.) so the caller falls through to its normal missing-DEK handling.
nsresult TransferRefreshedDekLocked(nsIFile* aProfileDir,
                                    const nsACString& aCollection,
                                    nsTArray<uint8_t>& aOutDek) {
  sStateMutex.AssertCurrentThreadOwns();

  // Read the source profile path from the marker file.
  nsCOMPtr<nsIFile> marker;
  if (NS_FAILED(aProfileDir->Clone(getter_AddRefs(marker)))) {
    return NS_ERROR_NOT_AVAILABLE;
  }
  marker->Append(u".sqlite-refresh-source"_ns);
  bool exists = false;
  if (NS_FAILED(marker->Exists(&exists)) || !exists) {
    return NS_ERROR_NOT_AVAILABLE;
  }
  nsCOMPtr<nsIInputStream> markerStream;
  if (NS_FAILED(
          NS_NewLocalFileInputStream(getter_AddRefs(markerStream), marker))) {
    return NS_ERROR_NOT_AVAILABLE;
  }
  nsAutoCString sourcePath;
  nsresult rv = NS_ReadInputStreamToString(markerStream, sourcePath, -1);
  markerStream->Close();
  if (NS_FAILED(rv)) {
    return NS_ERROR_NOT_AVAILABLE;
  }
  sourcePath.Trim(" \t\r\n");
  if (sourcePath.IsEmpty()) {
    return NS_ERROR_NOT_AVAILABLE;
  }

  // Open the SOURCE profile's keystore once and keep it cached for the rest of
  // the refresh (closed at shutdown). Do NOT open+close per collection:
  // lockstore caches keystores via a Weak ref that self-evicts when the last
  // Arc drops, so closing here would force a re-open of the source SQLite for
  // the next database (which fails -- only the first transfer would succeed).
  if (sRefreshSrcHandle && !sRefreshSrcPath.Equals(sourcePath)) {
    keystore_close(sRefreshSrcHandle);
    sRefreshSrcHandle = nullptr;
    sRefreshSrcPath.Truncate();
  }
  if (!sRefreshSrcHandle) {
    if (NS_FAILED(keystore_open(&sourcePath, &sRefreshSrcHandle)) ||
        !sRefreshSrcHandle) {
      sRefreshSrcHandle = nullptr;
      return NS_ERROR_NOT_AVAILABLE;
    }
    sRefreshSrcPath = sourcePath;
  }
  KeystoreHandle* srcHandle = sRefreshSrcHandle;

  // Read this database's DEK from the source, unlocking a Password KEK with the
  // cached primarySecret if needed (same install => same secret; a LocalKey
  // unlock is a no-op).
  nsTArray<nsCString> srcKeks;
  if (NS_FAILED(keystore_list_keks(srcHandle, &aCollection, &srcKeks)) ||
      srcKeks.IsEmpty()) {
    return NS_ERROR_NOT_AVAILABLE;
  }
  nsTArray<uint8_t> dek;
  nsresult gr = NS_ERROR_NOT_AVAILABLE;
  for (const auto& srcKek : srcKeks) {
    if (StringBeginsWith(srcKek, "lockstore::kek::password:"_ns) &&
        !sPrimarySecret.IsEmpty()) {
      (void)keystore_unlock_kek(srcHandle, &srcKek, &sPrimarySecret,
                                kKekCacheTimeoutMs);
    }
    gr = keystore_get_dek(srcHandle, &aCollection, &srcKek, &dek);
    if (NS_SUCCEEDED(gr)) {
      break;
    }
  }
  if (NS_FAILED(gr) || dek.Length() != kDekBytes) {
    return NS_ERROR_NOT_AVAILABLE;
  }

  // Import into THIS keystore, re-wrapped under our own KEK, then read it back.
  (void)keystore_import_dek(sHandle, &aCollection, &sKekRef, dek.Elements(),
                            dek.Length(), /* extractable */ true);
  rv = keystore_get_dek(sHandle, &aCollection, &sKekRef, &aOutDek);
  MOZ_LOG(
      GetSQLiteEncryptionLog(), LogLevel::Info,
      ("refresh: transferred DEK for %s from source profile (rv=0x%" PRIx32 ")",
       PromiseFlatCString(aCollection).get(), static_cast<uint32_t>(rv)));
  return rv;
}

NS_IMETHODIMP ProfileObserver::Observe(nsISupports*, const char* aTopic,
                                       const char16_t*) {
  if (!strcmp(aTopic, "profile-do-change")) {
    // Earliest reliable main-thread point at which the profile (and its cert
    // DB) is available, in BOTH the browser and xpcshell -- unlike
    // profile-after-change, which does not fire under xpcshell. It also
    // strictly precedes any QuotaManager database open (QuotaManager refuses to
    // be created before profile-do-change). Pre-initialize NSS here so the
    // later worker-thread opens never deadlock dispatching NSS init to a
    // blocked main thread.
    EnsureProfilePathCached();
    EnsureNSSInitializedForEncryptionIfReady();
    // Also pull the Felt-supplied primarySecret into our cache here,
    // but only in the spawned-Browser-Firefox case. The Felt UI
    // process itself never receives primarySecret over IPC (it's the
    // entity that fetches it), so polling there would burn the full
    // 5s timeout for nothing -- and GetEncryptionKey routes the UI
    // process to the LocalKey path regardless.
#if defined(MOZ_ENTERPRISE)
    if (StaticPrefs::security_storage_encryption_sqlite_enabled() &&
        is_felt_browser()) {
      (void)EnsurePrimarySecretCached();
    }
#endif
  } else if (!strcmp(aTopic, "profile-after-change")) {
    EnsureProfilePathCached();
    MarkProfileEncryptedIfNeeded();
  } else if (!strcmp(aTopic, "xpcom-will-shutdown")) {
    // Tear down lockstore last, at XPCOMWillShutdown. Every in-profile
    // encrypted database has already closed by now -- Places at
    // profile-before-change, QuotaManager/IndexedDB/DOM-storage at
    // profile-before-change-qm -- and nothing writes the profile after
    // AppShutdownTelemetry, so the keystore stays available for all of those
    // late writes (including each connection's final WAL checkpoint) and only
    // then closes. The SQLite WAL checkpoint inside the keystore's own Drop
    // still has two phases of headroom before LateWriteChecks activates at
    // XPCOMShutdownThreads (default toolkit.shutdown.lateWriteChecksStage = 2).
    ShutdownEncryptionKeystore();
  }
  return NS_OK;
}

}  // namespace

void InitEncryptionKeystore() {
  MOZ_ASSERT(NS_IsMainThread());

  // If we are already at or beyond XPCOMWillShutdown (e.g. a storage service
  // created very late in shutdown), don't register a teardown observer that
  // would never fire, and refuse to open a keystore that would never be closed.
  if (AppShutdown::IsInOrBeyond(ShutdownPhase::XPCOMWillShutdown)) {
    StaticMutexAutoLock lock(sStateMutex);
    sShuttingDown = true;
    return;
  }

  // Eagerly try to cache the profile path. If the profile is already
  // loaded this succeeds; otherwise we fall through to the observer
  // below.
  EnsureProfilePathCached();

  // If the profile is already available (the common case: the storage service
  // is created during NS_InitXPCOM, before profile-do-change), pre-initialize
  // NSS now so a later worker-thread database open never deadlocks dispatching
  // a synchronous NSS init to a blocked main thread -- e.g. PermissionManager
  // opening permissions.sqlite on its IO thread while the main thread holds, or
  // is waiting on, the permission-manager monitor. This runs before
  // InitializeUserPrefs; nsNSSComponent::InitializeNSS reads security.nocertdb
  // live (not via its `once`-mirror) so this early init does not prematurely
  // snapshot once-mirrored prefs.
  EnsureNSSInitializedForEncryptionIfReady();

  // Catch-up for the encrypted-profile marker: a storage service first
  // created after profile-after-change has already missed that notification,
  // so mark here too. No-op when the pref is off or the profile is not yet
  // available (MarkProfileEncryptedDatabases bails without a profile);
  // idempotent and append-only otherwise.
  MarkProfileEncryptedIfNeeded();

  if (sObserver) {
    return;
  }
  nsCOMPtr<nsIObserverService> os = mozilla::services::GetObserverService();
  if (!os) {
    return;
  }
  sObserver = new ProfileObserver();
  if (NS_FAILED(os->AddObserver(sObserver, "profile-do-change", false)) ||
      NS_FAILED(os->AddObserver(sObserver, "profile-after-change", false)) ||
      NS_FAILED(os->AddObserver(sObserver, "xpcom-will-shutdown", false))) {
    os->RemoveObserver(sObserver, "profile-do-change");
    os->RemoveObserver(sObserver, "profile-after-change");
    os->RemoveObserver(sObserver, "xpcom-will-shutdown");
    sObserver = nullptr;
  }
}

bool IsBootstrapDatabasePath(const nsACString& aPath) {
  // Single source of truth for the bootstrap-database name list; obfsvfs's
  // IsBootstrapBypassPath delegates here so the two cannot drift.
  static constexpr nsLiteralCString kBootstrapNames[] = {
      "lockstore.keys.sqlite"_ns, "key4.db"_ns, "cert9.db"_ns, "key3.db"_ns,
      "cert8.db"_ns};
  // Match both separators: the bootstrap databases reach obfsvfs as native OS
  // paths (rusqlite/skv open them directly, bypassing PreparePathForURI's
  // forward-slash normalization), so on Windows the basename is delimited by a
  // backslash.
  const nsDependentCSubstring basename =
      Substring(aPath, aPath.RFindCharInSet("/\\") + 1);
  for (const auto& name : kBootstrapNames) {
    if (basename == name) {
      return true;
    }
  }
  return false;
}

nsresult GetDatabaseEncryptionStatus(const nsACString& aDatabasePath,
                                     EncryptionStatus& aStatus) {
  // Pref gate. With obfsvfs registered as the SQLite default VFS, every
  // keyless sqlite3_open_v2 lands in this function via ObfsOpen; honour the
  // master encryption pref here so a turned-off enterprise build still
  // returns Plaintext for every path and obfsvfs forwards raw.
  if (!StaticPrefs::security_storage_encryption_sqlite_enabled()) {
    aStatus = EncryptionStatus::Plaintext;
    return NS_OK;
  }

  nsString profilePath;
  nsresult rv = GetCachedProfilePath(profilePath);
  NS_ENSURE_SUCCESS(rv, rv);

  // A database under the profile directory is encrypted; anything else (an
  // xpcshell temp file, a migration import opened from outside the profile)
  // has no stable per-database identifier and is opened as plaintext.
  //
  // We do a direct string prefix comparison rather than going through
  // nsIFile::Contains because on Windows callers that opt in to
  // nsILocalFileWin::SetUseDOSDevicePathSyntax (notably QuotaManager, for
  // MAX_PATH bypass -- see dom/quota/QuotaCommon.cpp) hand us paths with a
  // leading "\\?\" DOS-device prefix, while NS_APP_USER_PROFILE_50_DIR returns
  // a plain "C:\..." path. nsIFile::Contains prefix-matches the raw path
  // strings; the "\\?\" mismatch makes it report "outside profile" for
  // in-profile databases and drops them onto the plaintext base VFS.
  // Normalize by stripping the "\\?\" prefix from both sides before comparing.
  nsAutoString normalizedProfilePath;
  normalizedProfilePath.Assign(profilePath);
  nsAutoString normalizedDbPath;
  CopyUTF8toUTF16(aDatabasePath, normalizedDbPath);
#ifdef XP_WIN
  constexpr auto kDevicePrefix = u"\\\\?\\"_ns;
  if (StringBeginsWith(normalizedProfilePath, kDevicePrefix)) {
    normalizedProfilePath.Cut(0, kDevicePrefix.Length());
  }
  if (StringBeginsWith(normalizedDbPath, kDevicePrefix)) {
    normalizedDbPath.Cut(0, kDevicePrefix.Length());
  }
  constexpr char16_t kDirSeparator = u'\\';
#else
  constexpr char16_t kDirSeparator = u'/';
#endif

  bool isUnder = false;
  const uint32_t profileLen = normalizedProfilePath.Length();
  if (normalizedDbPath.Length() > profileLen &&
      normalizedDbPath.CharAt(profileLen) == kDirSeparator) {
#ifdef XP_WIN
    // Windows filesystems are case-insensitive; match nsLocalFileWin::Contains.
    isUnder = _wcsnicmp(char16ptr_t(normalizedProfilePath.get()),
                        char16ptr_t(normalizedDbPath.get()), profileLen) == 0;
#else
    isUnder = memcmp(normalizedProfilePath.get(), normalizedDbPath.get(),
                     profileLen * sizeof(char16_t)) == 0;
#endif
  }

  if (!isUnder) {
    aStatus = EncryptionStatus::Plaintext;
    MOZ_LOG(GetSQLiteEncryptionLog(), LogLevel::Debug,
            ("Database outside profile; opening unencrypted"));
    return NS_OK;
  }

  // Bootstrap bypass list. These in-profile SQLite databases must stay
  // plaintext because they would otherwise re-enter the encryption layer
  // during the very initialization that the encryption layer depends on:
  //
  //   - lockstore.keys.sqlite: the keystore itself. It is the source of
  //     every per-database DEK, so there is no outer key to encrypt it
  //     with. Encrypting it would require its own key, recursively.
  //
  //   - key4.db / cert9.db (and the legacy key3.db / cert8.db): NSS's own
  //     softoken databases, opened by libnss3's bundled SQLite during
  //     NSS_Initialize. Routing them through obfsvfs deadlocks the process
  //     because GetEncryptionKey -> keystore_open -> nss_rs::init re-enters
  //     NSS init while NSS_Initialize is still on the stack. NSS manages
  //     its own at-rest protection for the private-key material in
  //     key4.db; cert9.db holds public cert data.
  if (IsBootstrapDatabasePath(aDatabasePath)) {
    aStatus = EncryptionStatus::Plaintext;
    return NS_OK;
  }

  aStatus = EncryptionStatus::Encrypted;
  return NS_OK;
}

nsresult GetEncryptionKey(const nsACString& aDatabasePath, OpenIntent aIntent,
                          nsACString& aOutHexKey) {
  // The caller has already established via GetDatabaseEncryptionStatus that
  // this database lives under the profile; resolve the profile path again to
  // derive the lockstore collection name.
  nsString profilePath;
  nsresult rv = GetCachedProfilePath(profilePath);
  NS_ENSURE_SUCCESS(rv, rv);

  nsCOMPtr<nsIFile> profileDir = new nsLocalFile();
  rv = profileDir->InitWithPath(profilePath);
  NS_ENSURE_SUCCESS(rv, rv);

  nsCOMPtr<nsIFile> dbFile = new nsLocalFile();
  rv = dbFile->InitWithPath(NS_ConvertUTF8toUTF16(aDatabasePath));
  NS_ENSURE_SUCCESS(rv, rv);

  // The collection name is the database's path relative to the profile
  // directory (e.g. "places.sqlite", "storage/permanent/.../idb/x.sqlite").
  // Unique by construction and human-readable when inspecting the
  // lockstore SQLite directly.
  nsAutoCString collection;
  rv = dbFile->GetRelativePath(profileDir, collection);
  NS_ENSURE_SUCCESS(rv, rv);

  // Open the lockstore handle (memoised per-path), resolve the shared
  // SQLite LocalKey, and read/create this database's DEK -- all while
  // holding sStateMutex so ShutdownEncryptionKeystore can't close the
  // handle out from under us (mak: avoid use-after-close).
  nsTArray<uint8_t> dek;
  {
    StaticMutexAutoLock lock(sStateMutex);

    if (sShuttingDown) {
      // After xpcom-will-shutdown the keystore is (being) torn down; don't
      // re-open it or mint key material that would never be destroyed
      // (mak). Fail the open rather than silently dropping encryption.
      MOZ_LOG(GetSQLiteEncryptionLog(), LogLevel::Warning,
              ("Encryption key requested during shutdown"));
      return NS_ERROR_FAILURE;
    }

    rv = EnsureKeystoreAndKekLocked(NS_ConvertUTF16toUTF8(profilePath));
    if (NS_FAILED(rv)) {
      return rv;
    }

    rv = keystore_get_dek(sHandle, &collection, &sKekRef, &dek);
    if (rv == NS_ERROR_NOT_AVAILABLE && !sPrimarySecret.IsEmpty()) {
      // NS_ERROR_NOT_AVAILABLE here almost always means the DEK does not
      // exist yet (a new in-profile database), not that the Password KEK's
      // in-memory cache expired (TTL ~49d). Only pay the PBKDF2 re-unlock
      // when the KEK is genuinely locked; otherwise fall through to the
      // transfer/mint paths below. This avoids a full key derivation per
      // new database on first launch (~16 DBs x ~1.5-5s each otherwise).
      bool unlocked = false;
      if (NS_FAILED(keystore_is_kek_unlocked(sHandle, &sKekRef, &unlocked)) ||
          !unlocked) {
        MOZ_LOG(GetSQLiteEncryptionLog(), LogLevel::Debug,
                ("Password KEK locked; re-unlocking and retrying get_dek"));
        nsresult urv = keystore_unlock_kek(sHandle, &sKekRef, &sPrimarySecret,
                                           kKekCacheTimeoutMs);
        if (NS_SUCCEEDED(urv)) {
          rv = keystore_get_dek(sHandle, &collection, &sKekRef, &dek);
        }
      }
    }
    if (rv == NS_ERROR_NOT_AVAILABLE) {
      // A Profile Refresh may have copied this already-encrypted
      // database from a source profile whose DEK is not yet in this
      // profile's keystore. If the migrator left a refresh-source
      // marker, transfer this database's DEK from the source keystore
      // (re-wrapped under our own KEK); the imported key is the source's
      // real DEK, so the copied ciphertext stays readable. This must run
      // BEFORE minting: in a refresh the copied database is first opened
      // with CreateIfNew (the migrator's file copy lands afterwards), so
      // a missing DEK is not a cue to mint a fresh one -- that would
      // re-key the copied contents into garbage. Mint below only when
      // there is no refresh source to recover.
      rv = TransferRefreshedDekLocked(profileDir, collection, dek);
    }
    if (rv == NS_ERROR_NOT_AVAILABLE && aIntent == OpenIntent::CreateIfNew) {
      if (sMarkerWriteFailed) {
        // The EncryptedDatabases marker could not be written, so the launch
        // guard cannot protect newly-encrypted data; fail closed rather than
        // mint a DEK for a new database. Existing databases are unaffected: a
        // never-written marker means nothing was encrypted to load.
        MOZ_LOG(GetSQLiteEncryptionLog(), LogLevel::Error,
                ("EncryptedDatabases marker absent; refusing to encrypt %s",
                 collection.get()));
        return NS_ERROR_FAILURE;
      }
      // First time we see this new (in-profile) database: mint an extractable
      // DEK under the shared KEK. A racing thread may have created it first,
      // in which case create_dek reports the duplicate as NS_ERROR_FAILURE --
      // benign; the get_dek below is the arbiter. LoadExisting never mints a
      // key: a missing DEK for an existing database is a hard error (handled
      // below), not a cue to create one and make the contents unreadable.
      nsresult crv = keystore_create_dek(sHandle, &collection, &sKekRef,
                                         /* extractable */ true,
                                         /* key_size */ kDekBytes);
      if (NS_FAILED(crv)) {
        MOZ_LOG(GetSQLiteEncryptionLog(), LogLevel::Debug,
                ("create_dek returned 0x%" PRIx32 "; re-reading",
                 static_cast<uint32_t>(crv)));
      }
      rv = keystore_get_dek(sHandle, &collection, &sKekRef, &dek);
    }
    if (NS_FAILED(rv)) {
      // For an existing in-profile database NS_ERROR_NOT_AVAILABLE is the exact
      // signal we expect: the DEK is gone for a database we can no longer
      // decrypt (corruption / lost keystore) -- a hard dataloss error, distinct
      // from a locked or otherwise failing keystore. Either way this database
      // is keyable, so the open must fail rather than silently read or write
      // plaintext (gcp); remap NS_ERROR_NOT_AVAILABLE so it can never be
      // mistaken for a "not encrypted" signal at the call sites.
      if (rv == NS_ERROR_NOT_AVAILABLE && aIntent == OpenIntent::LoadExisting) {
        MOZ_LOG(GetSQLiteEncryptionLog(), LogLevel::Error,
                ("missing DEK for an existing encrypted database; failing the "
                 "open"));
      } else {
        MOZ_LOG(GetSQLiteEncryptionLog(), LogLevel::Error,
                ("get_dek failed: 0x%" PRIx32, static_cast<uint32_t>(rv)));
      }
      return rv == NS_ERROR_NOT_AVAILABLE ? NS_ERROR_FAILURE : rv;
    }
  }

  if (dek.Length() != kDekBytes) {
    MOZ_LOG(GetSQLiteEncryptionLog(), LogLevel::Error,
            ("Unexpected DEK length %zu", dek.Length()));
    return NS_ERROR_UNEXPECTED;
  }
  HexEncode(dek, aOutHexKey);
  return NS_OK;
}

// Delivery point for the console-supplied primarySecret, called from the Felt
// IPC client (FeltClientThread) in the spawned browsing Firefox when the
// PrimarySecret message arrives. Stores it for the Password KEK and wakes the
// EnsurePrimarySecretCached waiter. C linkage so the Felt Rust crate can call
// it directly; thread-safe (any thread) via sStateMutex. The secret is held
// only here, never on the Felt side.
extern "C" void mozStorageSetSqlitePrimarySecret(const nsACString* aHex) {
  StaticMutexAutoLock lock(sStateMutex);
  if (sShuttingDown) {
    return;
  }
  if (!aHex || aHex->IsEmpty()) {
    return;
  }
  sPrimarySecret = *aHex;
  MOZ_LOG(GetSQLiteEncryptionLog(), LogLevel::Info,
          ("primarySecret delivered by Felt (len=%zu)",
           static_cast<size_t>(aHex->Length())));
}

void ShutdownEncryptionKeystore() {
  // Unregister observer outside the mutex; ObserverService is main-thread
  // only and we need to avoid lock-order surprises.
  RefPtr<ProfileObserver> observer;
  {
    StaticMutexAutoLock lock(sStateMutex);
    observer = sObserver.forget();
  }
  if (observer) {
    nsCOMPtr<nsIObserverService> os = mozilla::services::GetObserverService();
    if (os) {
      os->RemoveObserver(observer, "profile-do-change");
      os->RemoveObserver(observer, "profile-after-change");
      os->RemoveObserver(observer, "xpcom-will-shutdown");
    }
  }

  StaticMutexAutoLock lock(sStateMutex);
  sShuttingDown = true;
  if (sHandle) {
    MOZ_LOG(GetSQLiteEncryptionLog(), LogLevel::Info,
            ("Shutting down lockstore"));
    (void)keystore_close(sHandle);
    sHandle = nullptr;
  }
  if (sRefreshSrcHandle) {
    (void)keystore_close(sRefreshSrcHandle);
    sRefreshSrcHandle = nullptr;
  }
  sRefreshSrcPath.Truncate();
  sKekRef.Truncate();
  sCachedProfilePath.Truncate();
  sPrimarySecret.Truncate();
}

}  // namespace mozilla::storage
