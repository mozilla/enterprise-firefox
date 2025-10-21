/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*-
 * vim: sw=2 ts=2 et lcs=trail\:.,tab\:>~ :
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "Persist.h"

#include "nsAppDirectoryServiceDefs.h"
#include "nsCOMPtr.h"
#include "nsIToolkitProfileService.h"
#include "nsIFile.h"
#include "nsIProperties.h"
#include "NSSErrorsService.h"
#include "nsServiceManagerUtils.h"
#include "prio.h"
#include "prerror.h"

#define KEYSTORE_MAGIC "# mozilla secure key storage\n"

nsresult GetCurrentProfilePath(nsAString& path) {
  nsCOMPtr<nsIProperties> dirSvc =
      do_GetService(NS_DIRECTORY_SERVICE_CONTRACTID);
  if (dirSvc) {
    nsCOMPtr<nsIFile> profD;
    nsresult rv = dirSvc->Get(NS_APP_USER_PROFILE_50_DIR, NS_GET_IID(nsIFile),
                              getter_AddRefs(profD));  // "ProfD"
    NS_ENSURE_SUCCESS(rv, rv);
    if (profD) {
      return profD->GetPath(path);
    }
  }
  return NS_ERROR_FAILURE;
}

nsresult GetOrCreateKeyFilePath(nsAString& path) {
  nsresult rv = GetCurrentProfilePath(path);
  NS_ENSURE_SUCCESS(rv, rv);
  path.Append(NS_LITERAL_STRING_FROM_CSTRING("/bikeshed"));

  PR_MakeDir(NS_ConvertUTF16toUTF8(path).get(), 0777);

  path.Append(NS_LITERAL_STRING_FROM_CSTRING("/keystore.enc"));

  return NS_OK;
}

nsresult LoadFileToString(const nsCOMPtr<nsIFile>& file, nsACString& contents) {
  PRFileDesc* desc;
  nsresult rv = file->OpenNSPRFileDesc(PR_RDONLY, PR_IRUSR | PR_IWUSR, &desc);
  NS_ENSURE_SUCCESS(rv, rv);

  unsigned char buf[1024];
  int count = 0;
  while ((count = PR_Read(desc, buf, 1024)) > 0) {
    contents.Append(mozilla::Span<unsigned char>(buf, count));
  }

  if (count < 0) return mozilla::psm::GetXPCOMFromNSSError(PR_GetError());
  return NS_OK;
}

nsresult AppendStringToFile(const nsCOMPtr<nsIFile>& file,
                            nsACString& contents) {
  PRFileDesc* desc;
  nsresult rv = file->OpenNSPRFileDesc(PR_WRONLY | PR_CREATE_FILE | PR_APPEND,
                                       PR_IRUSR | PR_IWUSR, &desc);
  NS_ENSURE_SUCCESS(rv, rv);

  if (PR_Write(desc, contents.Data(), (int)contents.Length()) < 0) {
    return mozilla::psm::GetXPCOMFromNSSError(PR_GetError());
  }
  return NS_OK;
}

nsresult LoadKeyFromDisk(nsAutoCString& identifier, nsCString& data,
                         unsigned int len) {
  nsCString fileContents;

  nsAutoString filePath;
  nsresult rv = GetOrCreateKeyFilePath(filePath);
  NS_ENSURE_SUCCESS(rv, rv);

  nsCOMPtr<nsIFile> file;
  rv = NS_NewLocalFile(filePath, getter_AddRefs(file));
  NS_ENSURE_SUCCESS(rv, rv);

  rv = LoadFileToString(file, fileContents);
  NS_ENSURE_SUCCESS(rv, rv);

  if (fileContents.Find(KEYSTORE_MAGIC) != 0) {
    return NS_ERROR_INVALID_SIGNATURE;
  }

  nsAutoCString needle = identifier + ":"_ns;

  int32_t keyLocation = fileContents.Find(needle.View());
  if (keyLocation == kNotFound) {
    return NS_ERROR_NOT_AVAILABLE;
  }

  keyLocation += (int32_t)needle.Length();

  if (fileContents.Length() < keyLocation + len) {
    return NS_ERROR_FILE_CORRUPTED;
  }

  data.Assign(fileContents.get() + keyLocation, len);
  return NS_OK;
}

nsresult StoreKeyToDisk(nsAutoCString& identifier, const nsCString& key) {
  nsAutoString filePath;
  nsresult rv = GetOrCreateKeyFilePath(filePath);
  NS_ENSURE_SUCCESS(rv, rv);

  nsCOMPtr<nsIFile> file;
  rv = NS_NewLocalFile(filePath, getter_AddRefs(file));
  NS_ENSURE_SUCCESS(rv, rv);

  bool needs_magic;
  file->Exists(&needs_magic);

  nsCString data;
  if (!needs_magic) {
    data.Append(KEYSTORE_MAGIC);
  }

  nsAutoCString keyLine = identifier + ":"_ns + key + "\n"_ns;
  data.Append(keyLine);

  return AppendStringToFile(file, data);
}
