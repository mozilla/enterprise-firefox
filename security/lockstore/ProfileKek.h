/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_security_lockstore_ProfileKek_h
#define mozilla_security_lockstore_ProfileKek_h

#include "nsLiteralString.h"

namespace mozilla::security::lockstore {

// Constants for the profile KEK
constexpr auto kProfileKekId = "profile"_ns;
constexpr auto kProfilePasswordKek = "lockstore::kek::password:profile"_ns;
constexpr auto kProfileLocalKek = "lockstore::kek::local:profile"_ns;

}  // namespace mozilla::security::lockstore

#endif  // mozilla_security_lockstore_ProfileKek_h
