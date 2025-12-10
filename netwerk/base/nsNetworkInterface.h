/* vim: et ts=2 sw=2 tw=80
 */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef nsNetworkInterface_h__
#define nsNetworkInterface_h__

#include "nsINetworkInterface.h"
#include "nsPrintfCString.h"

#if defined(XP_WIN)
#  include <windows.h>
#  include <winsock2.h>
#  include <iptypes.h>
#  include <iphlpapi.h>
#  include <ws2ipdef.h>
#  include <ws2tcpip.h>
#endif

class NetworkInterface {
 public:
  explicit NetworkInterface() = default;

#if defined(XP_WIN)
  NetworkInterface(IP_ADAPTER_ADDRESSES* aAdapter);
  void GetIP(SOCKET_ADDRESS* aSockAddr, nsACString& aIpAddr);
  void AddIP(SOCKET_ADDRESS* aSockAddr);
  void AddGW(SOCKET_ADDRESS* aSockAddr);
#endif

#if defined(XP_UNIX)
  NetworkInterface(const nsAutoCString aName, const uint8_t* aMac);
  void AddIP(const struct in_addr* aAddr);
  void AddIP(const struct in6_addr* aAddr);
  void AddGW(const struct in_addr* aAddr);
  void AddGW(const struct in6_addr* aAddr);
#endif

  NetworkInterface(const NetworkInterface& aIntf);

  nsCString& Name() { return mName; }
  nsCString& Mac() { return mMAC; }

  nsTArray<nsCString> GetGwv4() const { return mGwv4.Clone(); };
  nsTArray<nsCString> GetGwv6() const { return mGwv6.Clone(); };
  nsTArray<nsCString> GetIpv4() const { return mIpv4.Clone(); };
  nsTArray<nsCString> GetIpv6() const { return mIpv6.Clone(); };

  void setMAC(const uint8_t* aAddr);
#if defined(XP_MACOSX)
  void setMAC(struct sockaddr_dl* aLink);
#endif

 private:
  void GetIP(const in_addr* aAddr, nsACString& aIpAddr);
  void GetIP(const in6_addr* aAddr, nsACString& aIpAddr);
  void GetIP(const sockaddr_in* aAddr, nsACString& aIpAddr);
  void GetIP(const sockaddr_in6* aAddr, nsACString& aIpAddr);

  nsTArray<nsCString> mGwv4;
  nsTArray<nsCString> mGwv6;
  nsTArray<nsCString> mIpv4;
  nsTArray<nsCString> mIpv6;

  nsCString mName;
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
