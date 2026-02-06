/* vim: et ts=2 sw=2 tw=80
 */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsNetworkInterface.h"
#include "nsString.h"
#include "mozilla/net/DNS.h"

NetworkInterface::NetworkInterface(const NetworkInterface& aIntf)
    : mName(aIntf.mName), mMAC(aIntf.mMAC) {
  mGwv4 = aIntf.GetGwv4();
  mGwv6 = aIntf.GetGwv6();
  mIpv4 = aIntf.GetIpv4();
  mIpv6 = aIntf.GetIpv6();
};

void NetworkInterface::GetIP(const in_addr* aAddr, nsACString& aIpAddr) {
  char addr[INET_ADDRSTRLEN] = {0};
  inet_ntop(AF_INET, aAddr, addr, INET_ADDRSTRLEN);
  aIpAddr.Assign(addr);
}

void NetworkInterface::GetIP(const in6_addr* aAddr, nsACString& aIpAddr) {
  char addr[INET6_ADDRSTRLEN] = {0};
  inet_ntop(AF_INET6, aAddr, addr, INET6_ADDRSTRLEN);
  aIpAddr.Assign(addr);
}

void NetworkInterface::GetIP(const sockaddr_in* aAddr, nsACString& aIpAddr) {
  GetIP(&aAddr->sin_addr, aIpAddr);
}

void NetworkInterface::GetIP(const sockaddr_in6* aAddr, nsACString& aIpAddr) {
  GetIP(&aAddr->sin6_addr, aIpAddr);
}

void NetworkInterface::setMAC(const uint8_t* aAddr) {
  mMAC = nsPrintfCString("%02x:%02x:%02x:%02x:%02x:%02x", aAddr[0], aAddr[1],
                         aAddr[2], aAddr[3], aAddr[4], aAddr[5]);
}

#if defined(XP_WIN)
NetworkInterface::NetworkInterface(PIP_ADAPTER_ADDRESSES aAdapter)
    : mName(NS_ConvertUTF16toUTF8(aAdapter->FriendlyName)) {
  uint8_t macAddress[MAX_ADAPTER_ADDRESS_LENGTH] = {0};
  if (aAdapter->PhysicalAddressLength != 0) {
    memcpy(&macAddress, aAdapter->PhysicalAddress,
           aAdapter->PhysicalAddressLength);
  }
  setMAC(macAddress);

  for (PIP_ADAPTER_UNICAST_ADDRESS pip = aAdapter->FirstUnicastAddress; pip;
       pip = pip->Next) {
    AddIP(&pip->Address);
  }

  for (IP_ADAPTER_GATEWAY_ADDRESS* pGw = aAdapter->FirstGatewayAddress; pGw;
       pGw = pGw->Next) {
    AddGW(&pGw->Address);
  }
}

void NetworkInterface::AddIP(SOCKET_ADDRESS* aSockAddr) {
  nsCString ip;

  if (aSockAddr->lpSockaddr->sa_family == AF_INET) {
    GetIP(reinterpret_cast<sockaddr_in*>(aSockAddr->lpSockaddr), ip);
    mIpv4.AppendElement(std::move(ip));
  } else if (aSockAddr->lpSockaddr->sa_family == AF_INET6) {
    GetIP(reinterpret_cast<sockaddr_in6*>(aSockAddr->lpSockaddr), ip);
    mIpv6.AppendElement(std::move(ip));
  }
}

void NetworkInterface::AddGW(SOCKET_ADDRESS* aSockAddr) {
  nsCString ip;

  if (aSockAddr->lpSockaddr->sa_family == AF_INET) {
    GetIP(reinterpret_cast<sockaddr_in*>(aSockAddr->lpSockaddr), ip);
    mGwv4.AppendElement(std::move(ip));
  } else if (aSockAddr->lpSockaddr->sa_family == AF_INET6) {
    GetIP(reinterpret_cast<sockaddr_in6*>(aSockAddr->lpSockaddr), ip);
    mGwv6.AppendElement(std::move(ip));
  }
}
#endif  // defined(XP_WIN)

#if defined(XP_LINUX)
NetworkInterface::NetworkInterface(const nsAutoCString aName,
                                   const uint8_t* aMac)
    : mName(aName) {
  setMAC(aMac);
}

void NetworkInterface::AddIP(const struct in_addr* aAddr) {
  nsCString ip;
  GetIP(aAddr, ip);
  mIpv4.AppendElement(std::move(ip));
}

void NetworkInterface::AddIP(const struct in6_addr* aAddr) {
  nsCString ip;
  GetIP(aAddr, ip);
  mIpv6.AppendElement(std::move(ip));
}

void NetworkInterface::AddGW(const struct in_addr* aAddr) {
  nsCString ip;
  GetIP(aAddr, ip);
  mGwv4.AppendElement(std::move(ip));
}

void NetworkInterface::AddGW(const struct in6_addr* aAddr) {
  nsCString ip;
  GetIP(aAddr, ip);
  mGwv6.AppendElement(std::move(ip));
}
#endif

#if defined(XP_MACOSX)
NetworkInterface::NetworkInterface(
    const char* aName,
    nsTHashMap<nsCString, nsTArray<std::pair<int, nsCString>>>& aRoutes,
    struct ifaddrs* aIfap)
    : mName(aName) {
  const auto& routingEntry = aRoutes.Lookup(Name());
  if (routingEntry) {
    for (const auto& ipAddrPair : *routingEntry) {
      if (ipAddrPair.first == AF_INET) {
        AddGWv4(std::move(ipAddrPair.second));
      } else if (ipAddrPair.first == AF_INET6) {
        AddGWv6(std::move(ipAddrPair.second));
      }
    }
  }

  for (struct ifaddrs* ifa = aIfap; ifa; ifa = ifa->ifa_next) {
    if (ifa->ifa_addr == NULL) {
      continue;
    }

    if (strcmp(aName, ifa->ifa_name) != 0) {
      continue;
    }

    if (AF_INET6 == ifa->ifa_addr->sa_family) {
      AddIP((struct sockaddr_in6*)ifa->ifa_addr);
    } else if (AF_INET == ifa->ifa_addr->sa_family) {
      AddIP((struct sockaddr_in*)ifa->ifa_addr);
    }

    if (AF_LINK == ifa->ifa_addr->sa_family) {
      setMAC((struct sockaddr_dl*)ifa->ifa_addr);
    }
  }
}

void NetworkInterface::AddIP(const struct sockaddr_in* aAddr) {
  nsCString ip;
  GetIP(aAddr, ip);
  mIpv4.AppendElement(std::move(ip));
}

void NetworkInterface::AddIP(const struct sockaddr_in6* aAddr) {
  nsCString ip;
  GetIP(aAddr, ip);
  mIpv6.AppendElement(std::move(ip));
}

void NetworkInterface::AddGWv4(const nsACString&& aIp) {
  mGwv4.AppendElement(aIp);
}

void NetworkInterface::AddGWv6(const nsACString&& aIp) {
  mGwv6.AppendElement(aIp);
}

void NetworkInterface::setMAC(struct sockaddr_dl* aLink) {
  if (aLink) {
    if (aLink->sdl_alen) {
      uint8_t mac_addr[aLink->sdl_alen];
      memcpy(mac_addr, aLink->sdl_data + aLink->sdl_nlen, aLink->sdl_alen);
      setMAC(mac_addr);
    } else {
      uint8_t mac_addr[6] = {0};
      setMAC(mac_addr);
    }
  }
}

bool getRoutesForNetworkInterfaces(
    struct rt_msghdr* rtm,
    nsTHashMap<nsCString, nsTArray<std::pair<int, nsCString>>>& ifNameAndIp,
    bool skipDstCheck) {
  struct sockaddr* sa;
  if ((rtm->rtm_addrs & (RTA_DST | RTA_GATEWAY)) != (RTA_DST | RTA_GATEWAY)) {
    return false;
  }

  sa = reinterpret_cast<struct sockaddr*>(rtm + 1);

  struct sockaddr* destination =
      reinterpret_cast<struct sockaddr*>((char*)sa + RTAX_DST * SA_SIZE(sa));
  if (!destination) {
    return false;
  }

  if (destination->sa_family != AF_INET && destination->sa_family != AF_INET6) {
    return false;
  }

  struct sockaddr* gateway = reinterpret_cast<struct sockaddr*>(
      (char*)sa + RTAX_GATEWAY * SA_SIZE(sa));
  if (!gateway) {
    return false;
  }

  if (gateway->sa_family != AF_INET && gateway->sa_family != AF_INET6) {
    return false;
  }

  nsCString ipAddr;
  if (gateway->sa_family == AF_INET) {
    NetworkInterface::GetIP(
        reinterpret_cast<const struct sockaddr_in*>(gateway), ipAddr);
  } else if (gateway->sa_family == AF_INET6) {
    NetworkInterface::GetIP(
        reinterpret_cast<const struct sockaddr_in6*>(gateway), ipAddr);
  }

  char buf[IFNAMSIZ] = {0};
  char* if_name = if_indextoname(rtm->rtm_index, buf);
  if (!if_name) {
    LOG(("getRoutes: AF_INET if_indextoname failed"));
    return false;
  }

  nsCString ifName = nsCString(if_name);
  std::pair<int, nsCString> ipAddrPair =
      std::make_pair(destination->sa_family, ipAddr);

  auto& ifNameEntry = ifNameAndIp.LookupOrInsert(ifName);
  LOG(("getRoutes: ifNameEntry for %s", ifName.get()));
  if (!ifNameEntry.Contains(ipAddrPair)) {
    LOG(("getRoutes: ifNameEntry for %s does not contain %s, adding",
         ifName.get(), ipAddr.get()));
    ifNameEntry.AppendElement(ipAddrPair);
  }

  return true;
}
#endif  // defined(XP_MACOSX)

NS_IMPL_ISUPPORTS(nsNetworkInterface, nsINetworkInterface)

NS_IMETHODIMP nsNetworkInterface::GetName(nsACString& aName) {
  aName = mIntf.Name();
  return NS_OK;
}

NS_IMETHODIMP nsNetworkInterface::GetMac(nsACString& aMac) {
  aMac = mIntf.Mac();
  return NS_OK;
}

NS_IMETHODIMP nsNetworkInterface::GetGwv4(nsTArray<nsCString>& aGwv4) {
  aGwv4 = mIntf.GetGwv4();
  return NS_OK;
}

NS_IMETHODIMP nsNetworkInterface::GetGwv6(nsTArray<nsCString>& aGwv6) {
  aGwv6 = mIntf.GetGwv6();
  return NS_OK;
}

NS_IMETHODIMP nsNetworkInterface::GetIpv4(nsTArray<nsCString>& aIpv4) {
  aIpv4 = mIntf.GetIpv4();
  return NS_OK;
}

NS_IMETHODIMP nsNetworkInterface::GetIpv6(nsTArray<nsCString>& aIpv6) {
  aIpv6 = mIntf.GetIpv6();
  return NS_OK;
}
