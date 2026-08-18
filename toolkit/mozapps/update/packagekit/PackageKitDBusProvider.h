/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

#ifndef PackageKitDBusProvider_h
#define PackageKitDBusProvider_h

#include <gio/gio.h>
#include <glib.h>

#include "mozilla/MozPromise.h"
#include "mozilla/RefPtr.h"

#include "nsCOMPtr.h"
#include "nsTArray.h"
#include "nsString.h"

#include "nsIPackageKitDBusProvider.h"

namespace mozilla::dom {

// Represents a single available package update reported by PackageKit.
// Each entry corresponds to one "Package" signal emitted by the transaction,
// with info (the PkInfoEnum), package_id, and summary.
struct PackageKitSignalPackage {
  // The PkInfoEnum value (e.g. PK_INFO_ENUM_SECURITY = 8, PK_INFO_ENUM_NORMAL
  // = 6, ...). See:
  // https://www.freedesktop.org/software/PackageKit/gtk-doc/PackageKit-enumerations.html
  uint32_t mInfo;

  // The package ID string, e.g. "hal;0.1.2;i386;fedora"
  nsCString mPackageId;

  // A human-readable one-line summary of the package.
  nsCString mSummary;
};

// Promise type returned by PackageKitGetUpdates().
// Resolves with the list of available updates; rejects on any D-Bus or
// PackageKit error.
using PackageKitSignalsPackagePromise =
    MozPromise<nsTArray<PackageKitSignalPackage>, nsCString,
               /* IsExclusive = */ true>;

struct PackageKitSignalFiles {
  nsCString mPackageId;
  nsTArray<nsCString> mFileList;
};

using PackageKitSignalsFilesPromise =
    MozPromise<nsTArray<PackageKitSignalFiles>, nsCString,
               /* IsExclusive = */ true>;

struct PackageKitSignalProgress {
  nsCString mId;
  uint32_t mStatus;
  uint32_t mPercentage;
};

typedef mozilla::MozPromise<nsTArray<PackageKitSignalProgress>, nsCString, true>
    PackageKitSignalsProgressPromise;

class PackageKitPercentage final : public nsIPackageKitPercentage {
 public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSIPACKAGEKITPERCENTAGE

  explicit PackageKitPercentage(uint32_t aPercentage)
      : mPercentage(aPercentage) {}

 private:
  ~PackageKitPercentage() = default;
  uint32_t mPercentage;
};

class PackageKitDBusProvider final : public nsIPackageKitDBusProvider {
 public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSIPACKAGEKITDBUSPROVIDER

  PackageKitDBusProvider() : mCancellable(dont_AddRef(g_cancellable_new())) {}

  static already_AddRefed<PackageKitDBusProvider> GetInstance();

  RefPtr<PackageKitSignalsProgressPromise> PackageKitRefreshCache(
      bool aForce, nsIPackageKitProgressCallback* aCallback,
      GCancellable* aCancellable = nullptr);

  // Query PackageKit for all available system updates.
  //
  // Flow:
  //   1. Create a proxy for org.freedesktop.PackageKit on the system bus.
  //   2. Call CreateTransaction() to obtain a transaction object path.
  //   3. Create a proxy for org.freedesktop.PackageKit.Transaction on that
  //   path.
  //   4. Subscribe to the "Package" (and "Packages") signal to collect results.
  //   5. Subscribe to the "Finished" signal to know when to resolve the
  //   promise.
  //   6. Subscribe to the "ErrorCode" signal for error propagation.
  //   7. Call GetUpdates(filter=0 /* PK_FILTER_ENUM_NONE */) on the
  //   transaction.
  //
  // The returned promise resolves on the calling thread's event target.
  // aCancellable may be nullptr; pass a GCancellable if you want to be able to
  // abort in-flight D-Bus calls.
  RefPtr<PackageKitSignalsPackagePromise> PackageKitGetUpdates(
      GCancellable* aCancellable = nullptr);

  RefPtr<PackageKitSignalsFilesPromise> PackageKitDownloadPackages(
      const nsTArray<nsCString>& aPackageIds,
      nsIPackageKitProgressCallback* aCallback,
      GCancellable* aCancellable = nullptr);

  RefPtr<PackageKitSignalsProgressPromise> PackageKitUpdatePackages(
      const nsTArray<nsCString>& aPackageIds,
      nsIPackageKitProgressCallback* aCallback,
      GCancellable* aCancellable = nullptr);

 private:
  ~PackageKitDBusProvider() {
    if (mCancellable) {
      g_cancellable_cancel(mCancellable);
    }
  }

  RefPtr<GCancellable> mCancellable;
};

}  // namespace mozilla::dom

#endif /* PackageKitDBusProvider_h */
