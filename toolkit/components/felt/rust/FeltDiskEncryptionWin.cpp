/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include <windows.h>

#include <propidl.h>
#include <propsys.h>
#include <shlobj.h>

#include "mozilla/Assertions.h"
#include "mozilla/RefPtr.h"
#include "mozilla/mscom/Utils.h"
#include "nsCOMPtr.h"

// Explorer's BitLocker property. Older SDKs omit it from propkey.h.
static const PROPERTYKEY kVolumeBitLockerProtection = {
    {0x2d15a9a1,
     0xa556,
     0x4189,
     {0x91, 0xad, 0x02, 0x74, 0x58, 0xf1, 0x1a, 0x07}},
    1717};

/**
 * Reads System.Volume.BitLockerProtection for a mount path such as "C:\".
 * Returns false if the property is missing or is not an integer.
 *
 * Runs synchronously on the caller's background thread. That thread never
 * initializes COM itself; it belongs to the implicit MTA because
 * mscom::ProcessRuntime keeps the process MTA alive from startup.
 */
extern "C" bool felt_read_bitlocker_protection(const char16_t* aRoot,
                                               int32_t* aOutValue) {
  MOZ_ASSERT(mozilla::mscom::IsCurrentThreadMTA());
  if (!mozilla::mscom::IsCurrentThreadMTA()) {
    return false;
  }

  RefPtr<IPropertyStore> store;
  HRESULT hr = SHGetPropertyStoreFromParsingName(
      reinterpret_cast<const wchar_t*>(aRoot), nullptr, GPS_DEFAULT,
      IID_IPropertyStore, getter_AddRefs(store));
  if (FAILED(hr) || !store) {
    return false;
  }

  PROPVARIANT value;
  PropVariantInit(&value);
  hr = store->GetValue(kVolumeBitLockerProtection, &value);
  bool read = SUCCEEDED(hr) && (value.vt == VT_I4 || value.vt == VT_UI4);
  if (read) {
    *aOutValue = value.lVal;
  }
  PropVariantClear(&value);
  return read;
}
