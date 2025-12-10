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
  char addr[INET_ADDRSTRLEN];
  addr[0] = 0;
  inet_ntop(AF_INET, aAddr, addr, INET_ADDRSTRLEN);
  aIpAddr.Assign(addr);
}

void NetworkInterface::GetIP(const in6_addr* aAddr, nsACString& aIpAddr) {
  char addr[INET6_ADDRSTRLEN];
  addr[0] = 0;
  inet_ntop(AF_INET6, aAddr, addr, INET6_ADDRSTRLEN);
  aIpAddr.Assign(addr);
}

void NetworkInterface::GetIP(const sockaddr_in* aAddr, nsACString& aIpAddr) {
  GetIP(&aAddr->sin_addr, aIpAddr);
}

void NetworkInterface::GetIP(const sockaddr_in6* aAddr, nsACString& aIpAddr) {
  GetIP(&aAddr->sin6_addr, aIpAddr);
}

#if defined(XP_WIN)
NetworkInterface::NetworkInterface(IP_ADAPTER_ADDRESSES* aAdapter)
    : mName(NS_ConvertUTF16toUTF8(aAdapter->FriendlyName)) {
  uint8_t macAddress[6] = {0, 0, 0, 0, 0, 0};
  memcpy(&macAddress, aAdapter->PhysicalAddress,
         aAdapter->PhysicalAddressLength);
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

#if defined(XP_UNIX)
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

void NetworkInterface::setMAC(const uint8_t* aAddr) {
  mMAC = nsPrintfCString("%02x:%02x:%02x:%02x:%02x:%02x", aAddr[0], aAddr[1],
                         aAddr[2], aAddr[3], aAddr[4], aAddr[5]);
}

#if defined(XP_MACOSX)
void NetworkInterface::setMAC(struct sockaddr_dl* aLink) {}
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
