/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

#ifndef MobileBroadbandImeiProvider_h
#define MobileBroadbandImeiProvider_h

#include "nsIImeiProvider.h"

namespace mozilla::dom {

class MobileBroadbandImeiProvider final : public nsIImeiProvider {
 public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSIIMEIPROVIDER

  MobileBroadbandImeiProvider() = default;
  static already_AddRefed<MobileBroadbandImeiProvider> GetInstance();

 private:
  ~MobileBroadbandImeiProvider() = default;
};

}  // namespace mozilla::dom

#endif /* MobileBroadbandImeiProvider_h */
