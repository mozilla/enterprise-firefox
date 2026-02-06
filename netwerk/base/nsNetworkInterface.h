/* vim: et ts=2 sw=2 tw=80
 */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef nsNetworkInterface_h
#define nsNetworkInterface_h

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

#if defined(XP_MACOSX)
#  include "nsTArray.h"

// Directly from nsNetworkLinkService.mm
#  ifndef SA_SIZE
#    define SA_SIZE(sa)                                    \
      ((!(sa) || ((struct sockaddr*)(sa))->sa_len == 0)    \
           ? sizeof(uint32_t)                              \
           : 1 + ((((struct sockaddr*)(sa))->sa_len - 1) | \
                  (sizeof(uint32_t) - 1)))
#  endif

#  include <ifaddrs.h>
#  include <net/if.h>
#  include <net/if_dl.h>
#  include <net/route.h>
#  include <sys/socket.h>
#  include <sys/types.h>
#endif

class NetworkInterface {
 public:
  explicit NetworkInterface() = default;

#if defined(XP_WIN)
  explicit NetworkInterface(PIP_ADAPTER_ADDRESSES aAdapter);
  static void GetIP(SOCKET_ADDRESS* aSockAddr, nsACString& aIpAddr);
  void AddIP(SOCKET_ADDRESS* aSockAddr);
  void AddGW(SOCKET_ADDRESS* aSockAddr);
#endif

#if defined(XP_MACOSX)
  NetworkInterface(
      const char* aName,
      nsTHashMap<nsCString, nsTArray<std::pair<int, nsCString>>>& aRoutes,
      struct ifaddrs* aIfap);
  void AddIP(const struct sockaddr_in* aAddr);
  void AddIP(const struct sockaddr_in6* aAddr);
  void AddGWv4(const nsACString&& aIp);
  void AddGWv6(const nsACString&& aIp);
#endif

#if defined(XP_LINUX)
  NetworkInterface(const nsAutoCString aName, const uint8_t* aMac);
  void AddIP(const struct in_addr* aAddr);
  void AddIP(const struct in6_addr* aAddr);
  void AddGW(const struct in_addr* aAddr);
  void AddGW(const struct in6_addr* aAddr);
#endif

  NetworkInterface(const NetworkInterface& aIntf);

  nsCString Name() const { return mName; }
  nsCString Mac() const { return mMAC; }

  nsTArray<nsCString> GetGwv4() const { return mGwv4.Clone(); };
  nsTArray<nsCString> GetGwv6() const { return mGwv6.Clone(); };
  nsTArray<nsCString> GetIpv4() const { return mIpv4.Clone(); };
  nsTArray<nsCString> GetIpv6() const { return mIpv6.Clone(); };

  void setMAC(const uint8_t* aAddr);
#if defined(XP_MACOSX)
  void setMAC(struct sockaddr_dl* aLink);
#endif

  static void GetIP(const sockaddr_in* aAddr, nsACString& aIpAddr);
  static void GetIP(const sockaddr_in6* aAddr, nsACString& aIpAddr);

 private:
  static void GetIP(const in_addr* aAddr, nsACString& aIpAddr);
  static void GetIP(const in6_addr* aAddr, nsACString& aIpAddr);

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

#if defined(XP_MACOSX)
bool getRoutesForNetworkInterfaces(
    struct rt_msghdr* rtm,
    nsTHashMap<nsCString, nsTArray<std::pair<int, nsCString>>>& ifNameAndIp,
    bool skipDstCheck);
#endif  // defined(XP_MACOSX)

#endif  // !nsNetworkInterface_h
