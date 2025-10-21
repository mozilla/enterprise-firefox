/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*-
 * vim: sw=2 ts=2 et lcs=trail\:.,tab\:>~ :
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "KeyStorage.h"

#include "Persist.h"

#include "nsIInterfaceRequestor.h"
#include "nsIPK11Token.h"
#include "nsIPK11TokenDB.h"
#include "nsLocalFile.h"
#include "nsNSSHelper.h"
#include "mozilla/Base64.h"
#include "pk11sdr.h"

#include <iomanip>
#include <sstream>
#include <string>

static std::string ArrayToHexString(const unsigned char* array,
                                    unsigned int length) {
  std::ostringstream oss;
  oss << std::hex << std::setfill('0');
  // todo: replace string_view with span once we make the jump to C++20
  for (unsigned int i = 0; i < length; i++) {
    oss << std::setw(2) << static_cast<int>(array[i]);
  }
  return oss.str();
}

static nsresult WaitForTokenDB() {
  nsresult rv;

  nsCOMPtr<nsIPK11TokenDB> tokenDB =
      do_GetService("@mozilla.org/security/pk11tokendb;1", &rv);

  nsIPK11Token* internalToken;
  tokenDB->GetInternalKeyToken(&internalToken);

  bool logged_in, needs_login;
  rv = internalToken->NeedsLogin(&needs_login);
  NS_ENSURE_SUCCESS(rv, rv);
  while (needs_login && (rv = internalToken->IsLoggedIn(&logged_in)) == NS_OK &&
         !logged_in);
  NS_ENSURE_SUCCESS(rv, rv);
  return NS_OK;
}

namespace mozilla::storage::key {
nsresult GetKeyForPath(const char* aPath, nsCString& key) {
  nsIFile* file = MakeAndAddRef<nsLocalFile>().take();
  nsresult rv = file->InitWithNativePath(nsCString(aPath));
  NS_ENSURE_SUCCESS(rv, rv);

  return GetKeyForFile(file, key);
}

nsresult GetKeyForFile(nsIFile* aFile, nsCString& keyString) {
  nsAutoCString telemetryFilename;
  nsresult rv = aFile->GetNativeLeafName(telemetryFilename);
  NS_ENSURE_SUCCESS(rv, rv);

  rv = WaitForTokenDB();
  NS_ENSURE_SUCCESS(rv, rv);

  nsCString encodedKey;
  rv = LoadKeyFromDisk(telemetryFilename, encodedKey, 112);

  if (rv == NS_OK) {
    nsCString encryptedKey;
    rv = mozilla::Base64Decode(encodedKey, encryptedKey);
    NS_ENSURE_SUCCESS(rv, rv);

    SECItem data = {}, result = {};
    data.data = (unsigned char*)encryptedKey.Data();
    data.len = encryptedKey.Length();
    data.type = siBuffer;

    PK11SDR_Decrypt(&data, &result, nullptr);

    keyString.AssignASCII(ArrayToHexString(result.data, result.len));
  } else {
    unsigned char key[32];
    PK11_GenerateRandom(key, 32);

    keyString.AssignASCII(ArrayToHexString(key, 32));

    SECItem data = {}, result = {}, keyid = {siBuffer, nullptr, 0};
    data.data = key;
    data.len = 32;
    data.type = siBuffer;

    PK11SDR_Encrypt(&keyid, &data, &result, nullptr);

    nsCString encodedKey;
    rv =
        mozilla::Base64Encode((const char*)result.data, result.len, encodedKey);
    NS_ENSURE_SUCCESS(rv, rv);

    rv = StoreKeyToDisk(telemetryFilename, encodedKey);
    NS_ENSURE_SUCCESS(rv, rv);
  }

  return NS_OK;
}
}  // namespace mozilla::storage::key
