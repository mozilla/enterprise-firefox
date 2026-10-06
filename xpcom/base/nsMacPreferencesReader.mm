/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsMacPreferencesReader.h"
#include "CFTypeRefPtr.h"
#include "MacStringHelpers.h"
#include "nsString.h"

#include "js/JSON.h"
#include "js/RootingAPI.h"
#include "js/Value.h"
#include "mozilla/JSONStringWriteFuncs.h"

NS_IMPL_ISUPPORTS(nsMacPreferencesReader, nsIMacPreferencesReader)

using namespace mozilla;

static void EvaluateDict(JSONWriter* aWriter,
                         NSDictionary<NSString*, id>* aDict);

static void EvaluateArray(JSONWriter* aWriter, NSArray* aArray) {
  for (id elem in aArray) {
    if ([elem isKindOfClass:[NSString class]]) {
      aWriter->StringElement(MakeStringSpan([elem UTF8String]));
    } else if ([elem isKindOfClass:[NSNumber class]]) {
      aWriter->IntElement([elem longLongValue]);
    } else if ([elem isKindOfClass:[NSArray class]]) {
      aWriter->StartArrayElement();
      EvaluateArray(aWriter, elem);
      aWriter->EndArray();
    } else if ([elem isKindOfClass:[NSDictionary class]]) {
      aWriter->StartObjectElement();
      EvaluateDict(aWriter, elem);
      aWriter->EndObject();
    }
  }
}

static void EvaluateDict(JSONWriter* aWriter,
                         NSDictionary<NSString*, id>* aDict) {
  for (NSString* key in aDict) {
    id value = aDict[key];
    if ([value isKindOfClass:[NSString class]]) {
      aWriter->StringProperty(MakeStringSpan([key UTF8String]),
                              MakeStringSpan([value UTF8String]));
    } else if ([value isKindOfClass:[NSNumber class]]) {
      aWriter->IntProperty(MakeStringSpan([key UTF8String]),
                           [value longLongValue]);
    } else if ([value isKindOfClass:[NSArray class]]) {
      aWriter->StartArrayProperty(MakeStringSpan([key UTF8String]));
      EvaluateArray(aWriter, value);
      aWriter->EndArray();
    } else if ([value isKindOfClass:[NSDictionary class]]) {
      aWriter->StartObjectProperty(MakeStringSpan([key UTF8String]));
      EvaluateDict(aWriter, value);
      aWriter->EndObject();
    }
  }
}

// The values an administrator controls: those in the root-owned Any User
// domain, overridden by the device-level managed preferences that device-scope
// configuration profiles produce. Everything a standard user can control is
// left out.
static NSDictionary<NSString*, id>* AdminOwnedPreferences() {
  NSMutableDictionary<NSString*, id>* prefs = [NSMutableDictionary dictionary];

  auto anyUserPrefs = CFTypeRefPtr<CFDictionaryRef>::WrapUnderCreateRule(
      CFPreferencesCopyMultiple(nullptr, kCFPreferencesCurrentApplication,
                                kCFPreferencesAnyUser, kCFPreferencesAnyHost));
  if (anyUserPrefs) {
    [prefs addEntriesFromDictionary:(NSDictionary*)anyUserPrefs.get()];
  }

  // No public API tells device-scope managed values from user-scope ones, so
  // read the device-level file directly. If its location changes, we fail
  // closed.
  NSString* bundleID = [[NSBundle mainBundle] bundleIdentifier];
  if (bundleID) {
    NSString* path = [NSString
        stringWithFormat:@"/Library/Managed Preferences/%@.plist", bundleID];
    NSDictionary* managed = [NSDictionary dictionaryWithContentsOfFile:path];
    if (managed) {
      [prefs addEntriesFromDictionary:managed];
    }
  }

  return prefs;
}

NS_IMETHODIMP
nsMacPreferencesReader::PoliciesEnabled(bool aAdminOwnedOnly,
                                        bool* aPoliciesEnabled) {
  NSString* policiesEnabledStr =
      [NSString stringWithUTF8String:ENTERPRISE_POLICIES_ENABLED_KEY];
  if (!aAdminOwnedOnly) {
    *aPoliciesEnabled = [[NSUserDefaults standardUserDefaults]
                            boolForKey:policiesEnabledStr] == YES;
    return NS_OK;
  }
  id value = AdminOwnedPreferences()[policiesEnabledStr];
  *aPoliciesEnabled =
      [value respondsToSelector:@selector(boolValue)] && [value boolValue];
  return NS_OK;
}

NS_IMETHODIMP
nsMacPreferencesReader::ReadPreferences(bool aAdminOwnedOnly, JSContext* aCx,
                                        JS::MutableHandle<JS::Value> aResult) {
  JSONStringWriteFunc<nsAutoCString> jsonStr;
  JSONWriter w(jsonStr);
  w.Start();
  EvaluateDict(&w, aAdminOwnedOnly ? AdminOwnedPreferences()
                                   : [[NSUserDefaults standardUserDefaults]
                                         dictionaryRepresentation]);
  w.End();

  NS_ConvertUTF8toUTF16 jsonStr16(jsonStr.StringCRef());

  JS::RootedValue val(aCx);
  MOZ_ALWAYS_TRUE(JS_ParseJSON(aCx, jsonStr16.get(), jsonStr16.Length(), &val));

  aResult.set(val);
  return NS_OK;
}
