/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { AddonTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/AddonTestUtils.sys.mjs"
);

AddonTestUtils.initMochitest(this);

const RESTRICTED_DOMAINS_PREF = "extensions.webextensions.restrictedDomains";
const SHOW_PANE_PREF = "extensions.getAddons.showPane";
const RECOMMENDATIONS_PREF =
  "extensions.htmlaboutaddons.recommendations.enabled";

// A global "*": blocked would also block the mochitest harness's own extensions
// (SpecialPowers and mochikit). Exempt them by ID so block-all can be tested.
const HARNESS_EXEMPTIONS = {
  "special-powers@mozilla.org": { installation_mode: "allowed" },
  "mochikit@mozilla.org": { installation_mode: "allowed" },
};

function isRestricted(host) {
  return WebExtensionPolicy.isRestrictedURI(
    Services.io.newURI(`https://${host}/`)
  );
}

async function installWebExtension(id, manifest) {
  let xpi = AddonTestUtils.createTempWebExtensionFile({
    manifest: { browser_specific_settings: { gecko: { id } }, ...manifest },
  });
  await AddonTestUtils.promiseInstallFile(xpi);
  await TestUtils.waitForCondition(
    () => WebExtensionPolicy.getByID(id),
    `extension ${id} started up`
  );
  return AddonManager.getAddonByID(id);
}

// Uninstall and wait until the extension is fully shut down.
async function uninstallAndSettle(id) {
  let addon = await AddonManager.getAddonByID(id);
  await addon?.uninstall().catch(() => {});
  await TestUtils.waitForCondition(
    () => !WebExtensionPolicy.getByID(id),
    `extension ${id} fully shut down`
  );
}

// Applying, updating and removing an ExtensionSettings restricted_domains
// config must be reflected in the restrictedDomains pref, and the policy
// domains must not accumulate across live updates.
add_task(async function test_restricted_domains_apply_update_remove() {
  info("Applying ExtensionSettings with a restricted_domains entry.");
  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    {
      policies: {
        ExtensionSettings: {
          "*": { restricted_domains: ["one.example.com"] },
        },
      },
    },
    null
  );

  Assert.ok(isRestricted("one.example.com"), "one.example.com is restricted");
  Assert.ok(
    !isRestricted("two.example.com"),
    "two.example.com is not restricted yet"
  );
  Assert.ok(
    Services.prefs.prefIsLocked(RESTRICTED_DOMAINS_PREF),
    "restrictedDomains pref is locked so the user cannot override it"
  );

  info("Updating restricted_domains to a different domain.");
  await waitForLivePolicyUpdate({
    ExtensionSettings: {
      "*": { restricted_domains: ["two.example.com"] },
    },
  });

  Assert.ok(isRestricted("two.example.com"), "two.example.com is restricted");
  Assert.ok(
    !isRestricted("one.example.com"),
    "one.example.com is no longer restricted (replaced, not accumulated)"
  );

  info("Removing the ExtensionSettings policy.");
  await waitForLivePolicyUpdate({});

  Assert.ok(
    !isRestricted("one.example.com") && !isRestricted("two.example.com"),
    "no domains are restricted after removal"
  );
  Assert.ok(
    !Services.prefs.prefIsLocked(RESTRICTED_DOMAINS_PREF),
    "restrictedDomains pref is unlocked after removal"
  );
});

// A "*": blocked config locks the discovery/recommendations prefs and
// disallows temporary add-on installs; removal must restore all of them.
add_task(async function test_block_all_prefs_and_feature_reverted() {
  Assert.ok(
    !Services.prefs.prefIsLocked(SHOW_PANE_PREF),
    "getAddons.showPane is not locked before the policy"
  );

  info('Applying ExtensionSettings "*": blocked.');
  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    {
      policies: {
        ExtensionSettings: {
          "*": { installation_mode: "blocked" },
          ...HARNESS_EXEMPTIONS,
        },
      },
    },
    null
  );

  Assert.equal(
    Services.prefs.getBoolPref(SHOW_PANE_PREF, true),
    false,
    "getAddons.showPane is turned off"
  );
  Assert.ok(
    Services.prefs.prefIsLocked(SHOW_PANE_PREF),
    "getAddons.showPane is locked"
  );
  Assert.equal(
    Services.prefs.getBoolPref(RECOMMENDATIONS_PREF),
    false,
    "recommendations are turned off"
  );
  Assert.ok(
    Services.prefs.prefIsLocked(RECOMMENDATIONS_PREF),
    "recommendations pref is locked"
  );
  Assert.ok(
    !Services.policies.isAllowed("installTemporaryAddon"),
    "installTemporaryAddon is disallowed while blocking all extensions"
  );

  info("Removing the ExtensionSettings policy.");
  await waitForLivePolicyUpdate({});

  Assert.ok(
    !Services.prefs.prefIsLocked(SHOW_PANE_PREF),
    "getAddons.showPane is unlocked after removal"
  );
  Assert.equal(
    Services.prefs.getPrefType(SHOW_PANE_PREF),
    Services.prefs.PREF_INVALID,
    "getAddons.showPane is removed again after removal"
  );
  Assert.ok(
    !Services.prefs.prefIsLocked(RECOMMENDATIONS_PREF),
    "recommendations pref is unlocked after removal"
  );
  Assert.equal(
    Services.prefs.getBoolPref(RECOMMENDATIONS_PREF),
    true,
    "recommendations are restored to their default after removal"
  );
  Assert.ok(
    Services.policies.isAllowed("installTemporaryAddon"),
    "installTemporaryAddon is allowed again after removal"
  );
});

// install_sources restricts where add-ons can be installed from. Dropping it
// on a live update, and removing the policy, must both stop restricting.
add_task(async function test_install_sources_reset() {
  const allowed = Services.io.newURI("https://good.example.com/addon.xpi");
  const disallowed = Services.io.newURI("https://evil.example.com/addon.xpi");

  info("Applying ExtensionSettings with an install_sources allowlist.");
  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    {
      policies: {
        ExtensionSettings: {
          "*": { install_sources: ["https://good.example.com/*"] },
        },
      },
    },
    null
  );

  Assert.ok(
    Services.policies.allowedInstallSource(allowed),
    "a matching install source is allowed"
  );
  Assert.ok(
    !Services.policies.allowedInstallSource(disallowed),
    "a non-matching install source is blocked"
  );

  info("Updating the policy to drop install_sources.");
  await waitForLivePolicyUpdate({
    ExtensionSettings: {
      "*": { installation_mode: "allowed" },
    },
  });

  Assert.ok(
    Services.policies.allowedInstallSource(disallowed),
    "install sources are no longer restricted after install_sources is dropped"
  );

  info("Removing the ExtensionSettings policy.");
  await waitForLivePolicyUpdate({});

  Assert.ok(
    Services.policies.allowedInstallSource(allowed) &&
      Services.policies.allowedInstallSource(disallowed),
    "install sources remain unrestricted after removal"
  );
});

// Functional: runtime_blocked_hosts must actually stop the extension from
// accessing a host, the guard must be replaced (old host freed) on update, and
// cleared on removal.
add_task(async function test_runtime_blocked_hosts_blocks_access() {
  const id = "runtime-hosts-live@example.com";
  registerCleanupFunction(() => uninstallAndSettle(id));

  await installWebExtension(id, {
    name: "runtime_blocked_hosts live test",
    permissions: ["<all_urls>"],
  });

  // Start with a clean engine state
  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    { policies: {} },
    null
  );

  const hostA = Services.io.newURI("https://x.a.example.com/");
  const hostB = Services.io.newURI("https://x.b.example.com/");
  const canAccess = uri => WebExtensionPolicy.getByID(id).canAccessURI(uri);

  Assert.ok(canAccess(hostA), "extension can access host A before the policy");

  info("Block host A.");
  await waitForLivePolicyUpdate({
    ExtensionSettings: {
      [id]: {
        installation_mode: "allowed",
        runtime_blocked_hosts: ["*://*.a.example.com"],
      },
    },
  });
  await TestUtils.waitForCondition(
    () => !canAccess(hostA),
    "extension can no longer access blocked host A"
  );
  Assert.ok(canAccess(hostB), "extension can still access host B");

  info("Update to block host B instead of A.");
  await waitForLivePolicyUpdate({
    ExtensionSettings: {
      [id]: {
        installation_mode: "allowed",
        runtime_blocked_hosts: ["*://*.b.example.com"],
      },
    },
  });
  await TestUtils.waitForCondition(
    () => !canAccess(hostB),
    "host B is now blocked"
  );
  Assert.ok(
    canAccess(hostA),
    "host A is accessible again (old guard cleared before re-apply)"
  );

  info("Removing the policy clears the guards.");
  await waitForLivePolicyUpdate({});
  await TestUtils.waitForCondition(
    () => canAccess(hostB),
    "extension can access all hosts again after removal"
  );

  await uninstallAndSettle(id);
});

// Functional: the installation_mode lifecycle on a real add-on. force_installed
// locks removal + disabling; normal_installed frees disabling but keeps removal
// locked; blocked uninstalls the add-on. The policy is then removed and it is
// expected that nothing gets re-installed.
add_task(async function test_installation_mode_lifecycle() {
  const id = "install-mode-live@example.com";
  registerCleanupFunction(() => uninstallAndSettle(id));

  let addon = await installWebExtension(id, {
    name: "installation_mode live test",
  });
  Assert.ok(
    addon.permissions & AddonManager.PERM_CAN_UNINSTALL,
    "the add-on is user-uninstallable before any policy"
  );

  // Start with a clean engine state
  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    { policies: {} },
    null
  );

  info("force_installed: the user can no longer remove or disable it.");
  await waitForLivePolicyUpdate({
    ExtensionSettings: { [id]: { installation_mode: "force_installed" } },
  });
  await TestUtils.waitForCondition(
    () => !(addon.permissions & AddonManager.PERM_CAN_UNINSTALL),
    "force_installed removes the uninstall capability"
  );
  Assert.ok(
    !(addon.permissions & AddonManager.PERM_CAN_DISABLE),
    "force_installed removes the disable capability"
  );

  info("normal_installed: disabling is allowed again, removal still locked.");
  await waitForLivePolicyUpdate({
    ExtensionSettings: { [id]: { installation_mode: "normal_installed" } },
  });
  await TestUtils.waitForCondition(
    () => addon.permissions & AddonManager.PERM_CAN_DISABLE,
    "normal_installed restores the disable capability"
  );
  Assert.ok(
    !(addon.permissions & AddonManager.PERM_CAN_UNINSTALL),
    "normal_installed still locks removal"
  );

  info("blocked: the add-on is uninstalled live.");
  await waitForLivePolicyUpdate({
    ExtensionSettings: { [id]: { installation_mode: "blocked" } },
  });
  await TestUtils.waitForCondition(
    () => !WebExtensionPolicy.getByID(id),
    "the blocked add-on shuts down"
  );
  Assert.equal(
    await AddonManager.getAddonByID(id),
    null,
    "the blocked add-on is uninstalled live"
  );

  info(
    "Removing the ExtensionSettings policy (teardown; result not asserted)."
  );
  await waitForLivePolicyUpdate({});
});

// Functional: an installed extension whose permission is added to
// blocked_permissions must actually become disabled, and
// removing the policy must re-enable it.
add_task(async function test_blocked_permission_disables_and_reenables() {
  const id = "blocked-perm-live@example.com";
  registerCleanupFunction(() => uninstallAndSettle(id));

  let addon = await installWebExtension(id, {
    name: "blocked_permissions live test",
    permissions: ["history"],
  });
  Assert.ok(!addon.appDisabled, "the add-on is enabled before the policy");

  // Start with a clean engine state
  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    { policies: {} },
    null
  );

  info("Blocking the history permission via a live update.");
  await waitForLivePolicyUpdate({
    ExtensionSettings: {
      "*": { blocked_permissions: ["history"] },
    },
  });

  await TestUtils.waitForCondition(
    () => addon.appDisabled,
    "the add-on is disabled because it requires a blocked permission"
  );
  Assert.ok(addon.appDisabled, "the add-on is disabled by blocked_permissions");

  info("Removing the ExtensionSettings policy.");
  await waitForLivePolicyUpdate({});

  await TestUtils.waitForCondition(
    () => !addon.appDisabled,
    "the add-on is re-enabled once the permission is no longer blocked"
  );
  Assert.ok(!addon.appDisabled, "the add-on is re-enabled after removal");
  await TestUtils.waitForCondition(
    () => WebExtensionPolicy.getByID(id),
    "the add-on restarts after being re-enabled"
  );

  await uninstallAndSettle(id);
});

// A feature lock shared with another policy (installTemporaryAddon, also set by
// InstallAddonsPermission) must not be released when only ExtensionSettings is
// removed.
add_task(async function test_shared_feature_kept_while_sibling_holds_it() {
  info(
    'Applying "*": blocked together with InstallAddonsPermission Default:false.'
  );
  await EnterprisePolicyTesting.setupEngineWithRemotePolicies(
    {
      policies: {
        ExtensionSettings: {
          "*": { installation_mode: "blocked" },
          ...HARNESS_EXEMPTIONS,
        },
        InstallAddonsPermission: { Default: false },
      },
    },
    null
  );

  Assert.ok(
    !Services.policies.isAllowed("installTemporaryAddon"),
    "installTemporaryAddon is disallowed while both policies are active"
  );

  info(
    "Removing only ExtensionSettings; InstallAddonsPermission stays active."
  );
  await waitForLivePolicyUpdate({
    InstallAddonsPermission: { Default: false },
  });

  Assert.ok(
    !Services.policies.isAllowed("installTemporaryAddon"),
    "installTemporaryAddon stays disallowed because InstallAddonsPermission still holds it"
  );

  // Remove all policies to leave a clean state.
  await waitForLivePolicyUpdate({});
});
