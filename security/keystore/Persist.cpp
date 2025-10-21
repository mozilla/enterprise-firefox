/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*-
 * vim: sw=2 ts=2 et lcs=trail\:.,tab\:>~ :
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "Persist.h"

#include "mozilla/Base64.h"
#include "mozilla/dom/quota/QuotaManager.h"
#include "mozilla/MozPromise.h"
#include "mozilla/SyncRunnable.h"
#include "nsAppDirectoryServiceDefs.h"
#include "nsCOMPtr.h"
#include "nsCRTGlue.h"
#include "nsTHashMap.h"
#include "nsThreadUtils.h"
#include "nsHashtablesFwd.h"
#include "nsIToolkitProfileService.h"
#include "nsIFile.h"
#include "nsIProperties.h"
#include "nsNetUtil.h"
#include "nsNSSHelper.h"
#include "NSSErrorsService.h"
#include "nsServiceManagerUtils.h"
#include "nsStreamUtils.h"
#include "pk11sdr.h"
#include "prerror.h"
#include "prio.h"
#include "ScopedNSSTypes.h"

#include "KeyStorage.h"

#define KEYSTORE_MAGIC "# mozilla secure key storage\n"
#define KEYSTORE_PATH FILE_PATH_SEPARATOR "keystore.db"
#define SYSTEM_KEY_NAME "system"

namespace mozilla::storage::key {

struct Key {
  mozilla::UniqueSECItem key;
  mozilla::UniqueSECItem iv;

  Key() = default;

  Key(mozilla::UniqueSECItem key, mozilla::UniqueSECItem iv)
      : key(std::move(key)), iv(std::move(iv)) {}

  Key(const Key& other)
      : key(SECITEM_DupItem(other.key.get())),
        iv(SECITEM_DupItem(other.iv.get())) {}

  Key(Key&&) = default;

  Key& operator=(Key&&) = default;
};

mozilla::StaticMutex sKeyMutex;
MOZ_RUNINIT static nsTHashMap<nsCString, Key> sKeyMap;
constinit static mozilla::UniquePK11SymKey sSystemKey;
constinit nsString sProfilePath;

void ShutdownStorage() {
  mozilla::StaticMutexAutoLock lock(sKeyMutex);
  sSystemKey.reset(nullptr);
  sKeyMap.Clear();
  sProfilePath.Truncate();
}

void SetCurrentProfilePath(const nsAString& aPath) { sProfilePath = aPath; }

nsresult GetCurrentProfilePath(nsAString& aPath) {
  if (NS_WARN_IF(sProfilePath.IsEmpty())) {
    sProfilePath = NS_ConvertUTF8toUTF16(PR_GetEnv("XPCSHELL_TEST_PROFILE_DIR"));
  }
  aPath = sProfilePath;
  return NS_OK;
}

/// Create path directory for keystore file
nsresult GetKeyStorePath(nsAString& aPath) {
  nsresult rv = GetCurrentProfilePath(aPath);
  NS_ENSURE_SUCCESS(rv, rv);

  aPath.Append(NS_LITERAL_STRING_FROM_CSTRING(KEYSTORE_PATH));

  return NS_OK;
}

/// Load file contents into string
nsresult LoadFileToString(const nsCOMPtr<nsIFile>& aFile,
                          nsACString& aContents) {
  nsCOMPtr<nsIInputStream> stream;
  nsresult rv = NS_NewLocalFileInputStream(getter_AddRefs(stream), aFile.get());
  // Manually return for fnf error, to avoid having a misleading error message
  // in the logs. This is an expected case, that is handled elsewhere
  if (rv == NS_ERROR_FILE_NOT_FOUND) return NS_ERROR_FILE_NOT_FOUND;
  NS_ENSURE_SUCCESS(rv, rv);

  return NS_ConsumeStream(stream, UINT32_MAX, aContents);
}

/// Open file for appending and write string to it
nsresult AppendStringToFile(const nsCOMPtr<nsIFile>& aFile,
                            nsACString& aContents) {
  nsCOMPtr<nsIOutputStream> stream;
  nsresult rv = NS_NewLocalFileOutputStream(
      getter_AddRefs(stream), aFile.get(),
      PR_WRONLY | PR_CREATE_FILE | PR_APPEND, PR_IRUSR | PR_IWUSR);
  NS_ENSURE_SUCCESS(rv, rv);

  uint32_t count;
  rv = stream->Write(aContents.Data(), aContents.Length(), &count);
  NS_ENSURE_SUCCESS(rv, rv);
  if (count != aContents.Length()) return NS_ERROR_FAILURE;

  return NS_OK;
}

/// Import a single, encoded and encrypted key, and encoded IV as `path`
nsresult ImportKey(const nsCString& aPath, const nsCString& aEncodedKey,
                   const nsCString& aEncodedIV) {
  sKeyMutex.AssertCurrentThreadOwns();

  // Key and IV are encoded Base64 strings
  nsCString encryptedKey, stringIV;

  nsresult rv = mozilla::Base64Decode(aEncodedKey, encryptedKey);
  NS_ENSURE_SUCCESS(rv, rv);

  rv = mozilla::Base64Decode(aEncodedIV, stringIV);
  NS_ENSURE_SUCCESS(rv, rv);

  // Key and IV need to go into heap-allocated SECItems, because they may be
  // stored into sKeyMap, which outlives encryptedKey/stringIV
  mozilla::UniqueSECItem key(::SECITEM_AllocItem(nullptr, nullptr, 0));
  SECStatus stat =
      SECITEM_MakeItem(nullptr, key.get(), (unsigned char*)encryptedKey.Data(),
                       encryptedKey.Length());
  if (stat != SECSuccess) return MapSECStatus(stat);

  mozilla::UniqueSECItem iv(::SECITEM_AllocItem(nullptr, nullptr, 0));
  stat = SECITEM_MakeItem(nullptr, iv.get(), (unsigned char*)stringIV.Data(),
                          stringIV.Length());
  if (stat != SECSuccess) return MapSECStatus(stat);

  // Keystore contains one (1) "system" key which encrypts all other keys
  if (aPath == SYSTEM_KEY_NAME) {
    mozilla::UniqueSECItem result(::SECITEM_AllocItem(nullptr, nullptr, 0));

    // "System" key is encrypted through the SDR
    stat = PK11SDR_Decrypt(key.get(), result.get(), nullptr);
    if (stat != SECSuccess) return MapSECStatus(stat);

    mozilla::UniquePK11SlotInfo slot(PK11_GetInternalSlot());
    if (!slot) {
      return NS_ERROR_FAILURE;
    }

    sSystemKey = mozilla::UniquePK11SymKey(
        PK11_ImportSymKey(slot.get(), CKM_AES_GCM, PK11_OriginUnwrap,
                          CKA_ENCRYPT | CKA_DECRYPT, result.get(), nullptr));

    if (!sSystemKey) {
      return NS_ERROR_FAILURE;
    }
  } else {
    sKeyMap.InsertOrUpdate(aPath, Key{std::move(key), std::move(iv)});
  }

  return NS_OK;
}

/// Load keys from keystore file to memory
nsresult LoadKeysFromDisk() {
  sKeyMutex.AssertCurrentThreadOwns();

  nsCString fileContents;

  // Get the file to the key store in the profile and turn it into a file ref
  nsAutoString filePath;
  nsresult rv = GetKeyStorePath(filePath);
  NS_ENSURE_SUCCESS(rv, rv);

  if (!sKeyMap.IsEmpty()) {
    // Keys were loaded on another thread during GetKeyStorePath
    return NS_OK;
  }

  nsCOMPtr<nsIFile> file;
  rv = NS_NewLocalFile(filePath, getter_AddRefs(file));
  NS_ENSURE_SUCCESS(rv, rv);

  // Load all the file contents into one string
  rv = LoadFileToString(file, fileContents);
  if (rv == nsresult::NS_ERROR_FILE_NOT_FOUND) {
    // Non existent keystore is OK and will be handled outside of this
    // function
    return NS_OK;
  }
  NS_ENSURE_SUCCESS(rv, rv);

  // Verify keystore file
  if (fileContents.Find(KEYSTORE_MAGIC) != 0) {
    return NS_ERROR_INVALID_SIGNATURE;
  }

  // Go through each line
  for (const auto& line : fileContents.Split('\n')) {
    int32_t delimiter1 = line.Find(":"_ns.View());
    int32_t delimiter2 = line.RFind(":"_ns.View());
    // Ignore invalid or incomplete lines
    if (delimiter1 == kNotFound || delimiter1 == delimiter2) continue;

    // Each line holds a path/identifier, a key and an IV
    nsCString path, encodedKey, encodedIV;
    path.Assign(line.Data(), delimiter1);

    encodedKey.Assign(line.Data() + delimiter1 + 1,
                      delimiter2 - delimiter1 - 1);

    encodedIV.Assign(line.Data() + delimiter2 + 1,
                     line.Length() - delimiter2 - 1);

    rv = ImportKey(path, encodedKey, encodedIV);
    NS_ENSURE_SUCCESS(rv, rv);
  }
  return NS_OK;
}

/// Create "system" key
/// `keyOut` will contain the SDR encrypted key bytes
/// `SYSTEM_KEY` will the a AES-GCM PK11SymKey created from those bytes
nsresult CreateSystemKey(Key& aKeyOut) {
  sKeyMutex.AssertCurrentThreadOwns();

  // Every key is 32 bytes long
  mozilla::UniqueSECItem key =
      mozilla::UniqueSECItem(::SECITEM_AllocItem(nullptr, nullptr, 32));
  if (!key) return NS_ERROR_FAILURE;

  // Key data is random
  SECStatus stat = PK11_GenerateRandom(key->data, key->len);
  if (stat != SECSuccess) return MapSECStatus(stat);

  mozilla::UniqueSECItem encryptedKey(nullptr);

  mozilla::UniquePK11SlotInfo slot(PK11_GetInternalSlot());
  if (!slot) {
    return NS_ERROR_FAILURE;
  }

  sSystemKey = mozilla::UniquePK11SymKey(
      PK11_ImportSymKey(slot.get(), CKM_AES_GCM, PK11_OriginUnwrap,
                        CKA_ENCRYPT | CKA_DECRYPT, key.get(), nullptr));

  if (!sSystemKey) {
    return NS_ERROR_FAILURE;
  }

  // Use the default SDR key
  SECItem keyid = {siBuffer, nullptr, 0};

  // PK11SDR_EncryptWithMechanism will allocate the needed buffer in SECItem
  encryptedKey.reset(::SECITEM_AllocItem(nullptr, nullptr, 0));

  stat = PK11SDR_EncryptWithMechanism(nullptr, &keyid, CKM_AES_CBC, key.get(),
                                      encryptedKey.get(), nullptr);
  if (stat != SECSuccess) return MapSECStatus(stat);

  aKeyOut =
      Key{std::move(encryptedKey),
          mozilla::UniqueSECItem(::SECITEM_AllocItem(nullptr, nullptr, 0))};

  return NS_OK;
}

/// Create a new key
nsresult CreateKey(nsAutoCString& aIdentifier, Key& aKeyOut) {
  // Every key is 32 bytes long
  mozilla::UniqueSECItem key =
      mozilla::UniqueSECItem(::SECITEM_AllocItem(nullptr, nullptr, 32));
  if (!key) return NS_ERROR_FAILURE;

  // Key data is random
  SECStatus stat = PK11_GenerateRandom(key->data, key->len);
  if (stat != SECSuccess) return MapSECStatus(stat);

  mozilla::UniqueSECItem encryptedKey(nullptr);
  // IV exists regardless of wether the key is "system"
  mozilla::UniqueSECItem iv(::SECITEM_AllocItem(nullptr, nullptr, 12));
  if (!iv) return NS_ERROR_FAILURE;

  // IV data is also random
  stat = PK11_GenerateRandom(iv->data, iv->len);
  if (stat != SECSuccess) return MapSECStatus(stat);

  CK_GCM_PARAMS gcm_params;
  gcm_params.pIv = (CK_BYTE_PTR)iv->data;
  gcm_params.ulIvLen = iv->len;
  gcm_params.ulIvBits = iv->len * 8;
  gcm_params.pAAD = (CK_BYTE_PTR)aIdentifier.get();
  gcm_params.ulAADLen = aIdentifier.Length();
  gcm_params.ulTagBits = 128;

  SECItem gcm_item;
  gcm_item.type = siBuffer;
  gcm_item.data = (unsigned char*)&gcm_params;
  gcm_item.len = sizeof(gcm_params);

  // PK11_Encrypt needs an existing buffer
  encryptedKey.reset(::SECITEM_AllocItem(nullptr, nullptr, 64));
  if (!encryptedKey) return NS_ERROR_FAILURE;

  unsigned int encrypted_len = 0;

  stat =
      PK11_Encrypt(sSystemKey.get(), CKM_AES_GCM, &gcm_item, encryptedKey->data,
                   &encrypted_len, encryptedKey->len, key->data, key->len);
  if (stat != SECSuccess) return MapSECStatus(stat);

  // Resize buffer to actual length
  stat = SECITEM_ReallocItemV2(nullptr, encryptedKey.get(), encrypted_len);
  if (stat != SECSuccess) return MapSECStatus(stat);

  aKeyOut = Key{std::move(encryptedKey), std::move(iv)};

  return NS_OK;
}

// Append key to key store file, creating it if needed
nsresult WriteKeyToDisk(nsAutoCString& aIdentifier, Key& aKey) {
  sKeyMutex.AssertCurrentThreadOwns();

  // Key and IV need Base64 encoding for disk storage
  nsCString encodedKey, encodedIV;
  nsresult rv = mozilla::Base64Encode((const char*)aKey.key->data,
                                      aKey.key->len, encodedKey);
  NS_ENSURE_SUCCESS(rv, rv);

  rv = mozilla::Base64Encode((const char*)aKey.iv->data, aKey.iv->len,
                             encodedIV);
  NS_ENSURE_SUCCESS(rv, rv);

  // Get the file to the key store in the profile and turn it into a file ref
  nsAutoString filePath;
  rv = GetKeyStorePath(filePath);
  NS_ENSURE_SUCCESS(rv, rv);

  nsCOMPtr<nsIFile> file;
  rv = NS_NewLocalFile(filePath, getter_AddRefs(file));
  NS_ENSURE_SUCCESS(rv, rv);

  // If the file doesn't exist, we need to write the magic before anything
  // else
  bool file_exists;
  rv = file->Exists(&file_exists);
  NS_ENSURE_SUCCESS(rv, rv);

  nsCString fileString;
  if (!file_exists) {
    fileString.Append(KEYSTORE_MAGIC);
  }

  nsAutoCString keyEntry =
      aIdentifier + ":"_ns + encodedKey + ":"_ns + encodedIV + "\n"_ns;
  fileString.Append(keyEntry);

  return AppendStringToFile(file, fileString);
}

/// Create "system" key
nsresult InitializeKeys() {
  nsAutoCString system(SYSTEM_KEY_NAME);

  Key key = {0, 0};

  nsresult rv = CreateSystemKey(key);
  NS_ENSURE_SUCCESS(rv, rv);

  rv = WriteKeyToDisk(system, key);
  NS_ENSURE_SUCCESS(rv, rv);

  return NS_OK;
}

// Decrypt key with "system" key
SECStatus DecryptKey(Key& aKey, nsAutoCString& aIdentifier, SECItem* aData) {
  CK_GCM_PARAMS gcm_params;
  gcm_params.pIv = (CK_BYTE_PTR)aKey.iv->data;
  gcm_params.ulIvLen = aKey.iv->len;
  gcm_params.ulIvBits = aKey.iv->len * 8;
  gcm_params.pAAD = (CK_BYTE_PTR)aIdentifier.get();
  gcm_params.ulAADLen = aIdentifier.Length();
  gcm_params.ulTagBits = 128;

  SECItem gcm_item;
  gcm_item.type = siBuffer;
  gcm_item.data = (unsigned char*)&gcm_params;
  gcm_item.len = sizeof(gcm_params);

  SECITEM_AllocItem(nullptr, aData, 32);
  if (!aData->data) {
    PR_SetError(PR_OUT_OF_MEMORY_ERROR, 0);
    return SECFailure;
  }

  unsigned int decrypted_len = 0;

  SECStatus stat =
      PK11_Decrypt(sSystemKey.get(), CKM_AES_GCM, &gcm_item, aData->data,
                   &decrypted_len, aData->len, aKey.key->data, aKey.key->len);

  aData->len = decrypted_len;

  return stat;
}

/// Obtain requested key assuming owned mutex
nsresult FetchOrCreateKey(nsAutoCString& aIdentifier, SECItem* aData) {
  mozilla::StaticMutexAutoLock lock(sKeyMutex);

  nsresult rv;
  // Load keys if it hasn't happened yet
  if (sKeyMap.IsEmpty()) {
    MOZ_LOG(mozilla::storage::key::GetKeyStorageLog(), mozilla::LogLevel::Debug,
            ("Reading keys from disk"));
    rv = LoadKeysFromDisk();
    NS_ENSURE_SUCCESS(rv, rv);
    // No keys loaded, so the keystore didn't exist before. Create it!
    if (sSystemKey == nullptr) {
      MOZ_LOG(mozilla::storage::key::GetKeyStorageLog(),
              mozilla::LogLevel::Debug, ("Initializing key storage"));
      rv = InitializeKeys();
      NS_ENSURE_SUCCESS(rv, rv);
    }
  }

  // Key doesn't exist after keys have been loaded. Create it!
  if (!sKeyMap.Contains(aIdentifier)) {
    Key key = {};
    rv = CreateKey(aIdentifier, key);
    NS_ENSURE_SUCCESS(rv, rv);

    MOZ_LOG(mozilla::storage::key::GetKeyStorageLog(), mozilla::LogLevel::Debug,
            ("Writing key to disk: %s", aIdentifier.get()));

    // Copy key. WriteKeyToDisk may halt to wait for another thread to fetch a
    // key, which needs to know that `identifier` already has a key.
    sKeyMap.InsertOrUpdate(aIdentifier, Key(key));

    rv = WriteKeyToDisk(aIdentifier, key);
    NS_ENSURE_SUCCESS(rv, rv);
  }

  // Decrypt requested key with "system" key
  // Must be accessed through visitor, because UniqueSECItems can't be
  // copied and nsTHashMap doesn't return references throught Get()
  SECStatus stat = sKeyMap.WithEntryHandle(
      aIdentifier, [&aIdentifier, &aData](auto entryHandle) {
        return DecryptKey(entryHandle.Data(), aIdentifier, aData);
      });
  return MapSECStatus(stat);
}

}  // namespace mozilla::storage::key
