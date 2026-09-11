/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_security_lockstore_ProfileKekStartup_h
#define mozilla_security_lockstore_ProfileKekStartup_h

#include "mozilla/AlreadyAddRefed.h"
#include "nsIObserver.h"
#include "nsString.h"

extern "C" void mozSetProfileSecret(const nsACString* aHex);

namespace mozilla::security::lockstore {

// Brings up the shared profile KEK at profile-do-change, the earliest point the
// keystore can be opened and just before the first consumer (SQLite at-rest
// encryption) needs it.
class ProfileKekStartup final : public nsIObserver {
 public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSIOBSERVER

  ProfileKekStartup() = default;

  nsresult Init();

  // Returns the singleton instance registered under
  // "@mozilla.org/security/lockstore/profile-kek-startup;1", or nullptr if it
  // cannot be obtained.
  static already_AddRefed<ProfileKekStartup> GetSingleton();

 private:
  ~ProfileKekStartup() = default;

  friend void ::mozSetProfileSecret(const nsACString* aHex);

  // The Felt-delivered primarySecret. Felt sends it ahead of StartupReady and
  // the client loop handles messages in order, so the write lands on the Felt
  // IPC thread before the startup barrier in XRE_mainRun releases -- before
  // this service exists, hence before any reader. Unsynchronized on the
  // strength of that ordering; a second or late delivery would need a lock.
  static nsCString sFeltSecret;

  void OnProfileDoChange();
};

}  // namespace mozilla::security::lockstore

#endif  // mozilla_security_lockstore_ProfileKekStartup_h
