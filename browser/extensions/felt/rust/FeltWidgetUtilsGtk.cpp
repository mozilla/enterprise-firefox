/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsGTKToolkit.h"

extern "C" {

void felt_set_startup_token_or_timestamp(const char* aToken, uint32_t aTimestamp) {
  nsGTKToolkit* toolkit = nsGTKToolkit::GetToolkit();
  if (!toolkit) {
    return;
  }
  if (aToken && *aToken) {
    toolkit->SetStartupToken(nsDependentCString(aToken));
  }
  if (aTimestamp) {
    toolkit->SetFocusTimestamp(aTimestamp);
  }
}

void felt_get_startup_token_or_timestamp(const char** aOutToken, uint32_t* aOutTokenLen,
                         uint32_t* aOutTimestamp) {
  *aOutToken = nullptr;
  *aOutTokenLen = 0;
  *aOutTimestamp = 0;
  nsGTKToolkit* toolkit = nsGTKToolkit::GetToolkit();
  if (!toolkit) {
    return;
  }
  const nsCString& token = toolkit->GetStartupToken();
  if (!token.IsEmpty()) {
    *aOutToken = token.get();
    *aOutTokenLen = token.Length();
  } else {
    *aOutTimestamp = toolkit->GetFocusTimestamp();
  }
}

}  // extern "C"
