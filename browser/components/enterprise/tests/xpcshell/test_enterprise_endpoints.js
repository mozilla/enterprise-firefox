/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);

const CONSOLE_ADDRESS_PREF = "enterprise.console.address";

const ENDPOINT_PREFS = [
  {
    pref: "security.certerrors.mitm.priming.endpoint",
    path: "/api/misc/mitm/",
  },
  {
    pref: "captivedetect.canonicalURL",
    path: "/api/misc/portal/canonical.html",
  },
  {
    pref: "network.connectivity-service.IPv4.url",
    path: "/api/misc/connectivity?ipv4",
  },
  {
    pref: "network.connectivity-service.IPv6.url",
    path: "/api/misc/connectivity?ipv6",
  },
];

const { EnterpriseEndpoints } = ChromeUtils.importESModule(
  "resource:///modules/enterprise/EnterpriseEndpoints.sys.mjs"
);

function clear_state() {
  Services.prefs.clearUserPref(CONSOLE_ADDRESS_PREF);
  for (const { pref } of ENDPOINT_PREFS) {
    Services.prefs.clearUserPref(pref);
    Services.prefs.getDefaultBranch("").setStringPref(pref, "");
  }
}

add_setup(async function () {
  registerCleanupFunction(() => {
    clear_state();
  });
});

add_task(clear_state);

add_task(
  {
    skip_if: () => !AppConstants.MOZ_ENTERPRISE,
  },
  async function test_endpoints_derived_from_console_address() {
    Services.prefs.setStringPref(
      CONSOLE_ADDRESS_PREF,
      "https://console.example.com"
    );

    EnterpriseEndpoints.init();

    for (const { pref, path } of ENDPOINT_PREFS) {
      Assert.equal(
        Services.prefs.getStringPref(pref),
        `https://console.example.com${path}`,
        `${pref} should be derived from console address`
      );
    }
  }
);
add_task(clear_state);

add_task(
  {
    skip_if: () => !AppConstants.MOZ_ENTERPRISE,
  },
  async function test_empty_console_address_leaves_prefs_empty() {
    Services.prefs.setStringPref(CONSOLE_ADDRESS_PREF, "");

    EnterpriseEndpoints.init();

    for (const { pref } of ENDPOINT_PREFS) {
      Assert.equal(
        Services.prefs.getStringPref(pref),
        "",
        `${pref} should remain empty when console address is empty`
      );
    }
  }
);
add_task(clear_state);

add_task(
  {
    skip_if: () => !AppConstants.MOZ_ENTERPRISE,
  },
  async function test_user_value_not_clobbered() {
    Services.prefs.setStringPref(
      CONSOLE_ADDRESS_PREF,
      "https://console.example.com"
    );
    Services.prefs.setStringPref(
      "security.certerrors.mitm.priming.endpoint",
      "https://custom.example.com/mitm"
    );

    EnterpriseEndpoints.init();

    Assert.equal(
      Services.prefs.getStringPref("security.certerrors.mitm.priming.endpoint"),
      "https://custom.example.com/mitm",
      "User-set pref should not be overwritten by default-branch derivation"
    );

    const defaultValue = Services.prefs
      .getDefaultBranch("")
      .getStringPref("security.certerrors.mitm.priming.endpoint");
    Assert.equal(
      defaultValue,
      "https://console.example.com/api/misc/mitm/",
      "Default branch should still have the derived value"
    );
  }
);
add_task(clear_state);
