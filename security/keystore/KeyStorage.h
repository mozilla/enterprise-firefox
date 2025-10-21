/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*-
 * vim: sw=2 ts=2 et lcs=trail\:.,tab\:>~ :
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef KeyStorage_h
#define KeyStorage_h

#include "nsIFile.h"
#include "nsStringFwd.h"
#include "mozilla/Logging.h"

namespace mozilla::storage::key {
void Shutdown();

mozilla::LogModule* GetKeyStorageLog();

nsresult GetKeyByPath(const char* aPath, nsCString& aKey);
nsresult GetKeyByFile(nsIFile& aFile, nsCString& aKey);
}  // namespace mozilla::storage::key

#endif  // KeyStorage_h
