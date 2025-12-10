/* vim: et ts=2 sw=2 tw=80
 */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsNetworkInterface.h"
#include "nsString.h"
#include "mozilla/net/DNS.h"

NS_IMPL_ISUPPORTS(nsNetworkInterface, nsINetworkInterface)

NS_IMETHODIMP nsNetworkInterface::GetName(nsACString& aName) {
  aName = mIntf.mName;
  return NS_OK;
}

NS_IMETHODIMP nsNetworkInterface::GetMac(nsACString& aMac) {
  aMac = mIntf.mMAC;
  return NS_OK;
}

NS_IMETHODIMP nsNetworkInterface::GetGwv4(nsTArray<nsCString>& aGwv4) {
  aGwv4 = mIntf.mGwv4.Clone();
  return NS_OK;
}

NS_IMETHODIMP nsNetworkInterface::GetGwv6(nsTArray<nsCString>& aGwv6) {
  aGwv6 = mIntf.mGwv6.Clone();
  return NS_OK;
}

NS_IMETHODIMP nsNetworkInterface::GetIpv4(nsTArray<nsCString>& aIpv4) {
  aIpv4 = mIntf.mIpv4.Clone();
  return NS_OK;
}

NS_IMETHODIMP nsNetworkInterface::GetIpv6(nsTArray<nsCString>& aIpv6) {
  aIpv6 = mIntf.mIpv6.Clone();
  return NS_OK;
}
