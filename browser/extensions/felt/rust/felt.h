/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef felt_h
#define felt_h

#include "nsISupportsUtils.h"  // for nsresult, etc.

extern "C" {

void felt_init();

bool is_felt_ui();

bool is_felt_browser();

bool firefox_connect_to_felt(const char* server_name);

void firefox_felt_connection_start_thread();

bool firefox_felt_is_startup_complete();

nsresult felt_constructor(REFNSIID iid, void** result);

nsresult felt_restartforced_constructor(REFNSIID iid, void** result);

}  // extern "C"

#endif  // felt_h
