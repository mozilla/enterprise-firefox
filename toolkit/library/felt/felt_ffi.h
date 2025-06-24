/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef felt_ffi_h
#define felt_ffi_h

#include "nsISupportsUtils.h"  // for nsresult, etc.

extern "C" {

void felt_init();

void firefox_connect_to_felt(const char* server_name);

nsresult felt_constructor(REFNSIID iid, void** result);

nsresult felt_restartforced_constructor(REFNSIID iid, void** result);

}  // extern "C"

#endif  // felt_ffi_h
