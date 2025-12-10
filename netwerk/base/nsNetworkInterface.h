/* vim: et ts=2 sw=2 tw=80
 */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef nsNetworkInterface_h__
#define nsNetworkInterface_h__

#include "nsINetworkInterface.h"

class NetworkInterface {
 public:
  explicit NetworkInterface() = default;
  NetworkInterface(const NetworkInterface& aIntf)
      : mName(aIntf.mName), mMAC(aIntf.mMAC) {
    mGwv4 = aIntf.mGwv4.Clone();
    mGwv6 = aIntf.mGwv6.Clone();
    mIpv4 = aIntf.mIpv4.Clone();
    mIpv6 = aIntf.mIpv6.Clone();
  };

  nsCString mName;
  nsTArray<nsCString> mGwv4;
  nsTArray<nsCString> mGwv6;
  nsTArray<nsCString> mIpv4;
  nsTArray<nsCString> mIpv6;
  nsCString mMAC;
};

class nsNetworkInterface final : public nsINetworkInterface {
  ~nsNetworkInterface() = default;

 public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSINETWORKINTERFACE

  explicit nsNetworkInterface(const NetworkInterface* aIntf) : mIntf(*aIntf) {}

 private:
  NetworkInterface mIntf;

 protected:
  /* additional members */
};

#endif  // !nsNetworkInterface_h__
