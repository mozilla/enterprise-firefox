/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*-
 * vim: sw=2 ts=2 et lcs=trail\:.,tab\:>~ :
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "KeyStorage.h"

#include "Persist.h"

#include "mozilla/Logging.h"
#include "GMPUtils.h"
#include "nsLocalFile.h"
#include "ScopedNSSTypes.h"

namespace mozilla::storage::key {
void Shutdown() { ShutdownStorage(); }
mozilla::LogModule* GetKeyStorageLog() {
  static mozilla::LazyLogModule sLog("KeyStorage");

  return sLog;
}

nsresult GetKeyByPath(const char* aPath, nsCString& aKey) {
  nsCOMPtr<nsIFile> file = new nsLocalFile();
  nsresult rv = file->InitWithNativePath(nsCString(aPath));
  NS_ENSURE_SUCCESS(rv, rv);

  return GetKeyByFile(*file, aKey);
}

nsresult GetKeyByFile(nsIFile& aFile, nsCString& aKeyString) {
  nsAutoString profile_path;
  nsresult rv = GetCurrentProfilePath(profile_path);
  NS_ENSURE_SUCCESS(rv, rv);

  nsAutoString realFile;
  rv = aFile.GetPath(realFile);
  NS_ENSURE_SUCCESS(rv, rv);

  nsCOMPtr<nsIFile> profile = new nsLocalFile();
  rv = profile->InitWithPath(profile_path);
  NS_ENSURE_SUCCESS(rv, rv);

  nsAutoCString filename;
  rv = aFile.GetRelativePath(profile, filename);
  NS_ENSURE_SUCCESS(rv, rv);

  MOZ_LOG(GetKeyStorageLog(), LogLevel::Debug,
          ("Fetching key for %s", filename.get()));

  UniqueSECItem key(::SECITEM_AllocItem(nullptr, nullptr, 0));
  rv = FetchOrCreateKey(filename, key.get());
  NS_ENSURE_SUCCESS(rv, rv);

  aKeyString = mozilla::ToHexString(key->data, key->len);

  return NS_OK;
}
}  // namespace mozilla::storage::key
