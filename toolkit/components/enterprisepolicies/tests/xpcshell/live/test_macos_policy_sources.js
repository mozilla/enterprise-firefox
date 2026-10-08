/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Bug 2073015. Under console management, only administrator-controlled macOS
// values (device-scope configuration profiles and the Any User domain) are
// merged with the console's policies; values in the Current User domains are
// not.

const { ctypes } = ChromeUtils.importESModule(
  "resource://gre/modules/ctypes.sys.mjs"
);

const REMOTE_CONSOLE_POLICIES = {
  SecurityLogging: { Download: { Enabled: true } },
};

// Nested policies are written as flattened keys such as
// PictureInPicture__Enabled; each leaf is filtered on its own.
const USER_DEFAULTS = {
  EnterprisePoliciesEnabled: 1,
  BlockAboutConfig: 1,
  PictureInPicture__Enabled: 1,
};
const USER_POLICIES = ["BlockAboutConfig", "PictureInPicture"];

/**
 * Write integer values into the Current User domain for this process, which
 * NSUserDefaults reads. A null value removes the key.
 *
 * @param {Record<string, number|null>} values
 */
function setUserDefaults(values) {
  const kCFStringEncodingUTF8 = 0x08000100;
  const kCFNumberSInt32Type = 3;
  const cf = ctypes.open(
    "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation"
  );
  try {
    const CFStringCreateWithCString = cf.declare(
      "CFStringCreateWithCString",
      ctypes.default_abi,
      ctypes.voidptr_t,
      ctypes.voidptr_t,
      ctypes.char.ptr,
      ctypes.uint32_t
    );
    const CFNumberCreate = cf.declare(
      "CFNumberCreate",
      ctypes.default_abi,
      ctypes.voidptr_t,
      ctypes.voidptr_t,
      ctypes.long,
      ctypes.voidptr_t
    );
    const CFPreferencesSetAppValue = cf.declare(
      "CFPreferencesSetAppValue",
      ctypes.default_abi,
      ctypes.void_t,
      ctypes.voidptr_t,
      ctypes.voidptr_t,
      ctypes.voidptr_t
    );
    const CFPreferencesAppSynchronize = cf.declare(
      "CFPreferencesAppSynchronize",
      ctypes.default_abi,
      ctypes.uint8_t,
      ctypes.voidptr_t
    );
    const CFRelease = cf.declare(
      "CFRelease",
      ctypes.default_abi,
      ctypes.void_t,
      ctypes.voidptr_t
    );
    const currentApp = cf.declare(
      "kCFPreferencesCurrentApplication",
      ctypes.voidptr_t
    );

    for (const [key, value] of Object.entries(values)) {
      const cfKey = CFStringCreateWithCString(null, key, kCFStringEncodingUTF8);
      let cfValue = null;
      if (value !== null) {
        const number = new ctypes.int32_t(value);
        cfValue = CFNumberCreate(null, kCFNumberSInt32Type, number.address());
      }
      CFPreferencesSetAppValue(cfKey, cfValue, currentApp);
      if (cfValue) {
        CFRelease(cfValue);
      }
      CFRelease(cfKey);
    }
    CFPreferencesAppSynchronize(currentApp);
  } finally {
    cf.close();
  }
}

async function restartEngine() {
  const applied = EnterprisePolicyTesting.awaitAllPoliciesApplied();
  Services.obs.notifyObservers(null, "EnterprisePolicies:Restart");
  await applied;
}

add_setup(function () {
  // Removes the keys even if the machine had values for them before the test.
  registerCleanupFunction(() => {
    setUserDefaults(
      Object.fromEntries(Object.keys(USER_DEFAULTS).map(key => [key, null]))
    );
  });
  setUserDefaults(USER_DEFAULTS);
});

add_task(async function test_user_defaults_honored_without_console() {
  Services.prefs.setBoolPref("enterprise.policies.live.enabled", false);
  await restartEngine();
  Services.prefs.setBoolPref("enterprise.policies.live.enabled", true);

  const active = Services.policies.getActivePolicies();
  for (const name of USER_POLICIES) {
    Assert.ok(
      name in active,
      `Without a console, ${name} from the user's defaults domain applies`
    );
  }
});

add_task(async function test_user_defaults_ignored_under_console() {
  await EnterprisePolicyTesting.setupEngineWithRemotePolicies({
    policies: REMOTE_CONSOLE_POLICIES,
  });

  const active = Services.policies.getActivePolicies();
  Assert.ok("SecurityLogging" in active, "The console policy applies");
  for (const name of USER_POLICIES) {
    Assert.ok(
      !(name in active),
      `Under console management, ${name} from the user's defaults domain is ignored`
    );
  }
});
