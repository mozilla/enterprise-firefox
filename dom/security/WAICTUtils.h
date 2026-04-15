/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef WAICTUtils_h
#define WAICTUtils_h

#include <cstdint>

#include "mozilla/Logging.h"
#include "mozilla/Result.h"
#include "nsString.h"

class nsISFVDictionary;

namespace mozilla::waict {

extern LazyLogModule gWaictLog;

Result<nsCString, nsresult> ParseManifest(nsISFVDictionary* aDict);

Result<uint64_t, nsresult> ParseMaxAge(nsISFVDictionary* aDict);

enum class WaictMode { Enforce, Report };

Result<WaictMode, nsresult> ParseMode(nsISFVDictionary* aDict);

}  // namespace mozilla::waict

#endif  // WAICTUtils_h
