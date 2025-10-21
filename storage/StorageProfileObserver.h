/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef StorageProfileObserver_h
#define StorageProfileObserver_h

#include "nsIObserver.h"

namespace mozilla::storage {

class StorageProfileObserver final : public nsIObserver {
 public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSIOBSERVER

  StorageProfileObserver() = default;

 private:
  ~StorageProfileObserver() = default;
};

}  // namespace mozilla::storage

#endif  // StorageProfileObserver_h
