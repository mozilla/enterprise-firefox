/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "StorageProfileObserver.h"

#include "mozilla/security/Persist.h"
#include "nsAppDirectoryServiceDefs.h"
#include "nsDirectoryServiceUtils.h"
#include "nsIFile.h"

namespace mozilla::storage {

NS_IMPL_ISUPPORTS(StorageProfileObserver, nsIObserver)

NS_IMETHODIMP
StorageProfileObserver::Observe(nsISupports* aSubject, const char* aTopic,
                                const char16_t* aData) {
  if (strcmp(aTopic, "profile-do-change") != 0) {
    return NS_OK;
  }
  NS_DebugBreak(NS_DEBUG_WARNING, "profile-do-change observed", nullptr, __FILE__, __LINE__);

  nsCOMPtr<nsIFile> profileDir;
  nsresult rv = NS_GetSpecialDirectory(NS_APP_USER_PROFILE_50_DIR,
                                       getter_AddRefs(profileDir));
  NS_ENSURE_SUCCESS(rv, rv);

  nsAutoString path;
  rv = profileDir->GetPath(path);
  NS_ENSURE_SUCCESS(rv, rv);

  key::SetCurrentProfilePath(path);
  return NS_OK;
}

}  // namespace mozilla::storage
