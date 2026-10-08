/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

const pm = Services.perms;
const {
  ALLOW_ACTION,
  DENY_ACTION,
  UNKNOWN_ACTION,
  EXPIRE_NEVER,
  EXPIRE_POLICY,
} = Ci.nsIPermissionManager;

const principal =
  Services.scriptSecurityManager.createContentPrincipalFromOrigin(
    "https://policy.example.com"
  );

function addPolicyPermission() {
  pm.addFromPrincipal(principal, "cookie", ALLOW_ACTION, EXPIRE_POLICY);
}

function checkPolicyPermission(message) {
  let perm = pm.getPermissionObject(principal, "cookie", true);
  Assert.equal(perm?.capability, ALLOW_ACTION, message);
  Assert.equal(perm?.expireType, EXPIRE_POLICY, message);
}

add_setup(function () {
  Services.prefs.setCharPref("permissions.manager.defaultsUrl", "");
});

add_task(function test_policy_permission_rejects_other_callers() {
  addPolicyPermission();

  pm.removeFromPrincipal(principal, "cookie");
  checkPolicyPermission("removeFromPrincipal is rejected");

  pm.removeByType("cookie");
  checkPolicyPermission("removeByType is rejected");

  pm.addFromPrincipal(principal, "cookie", DENY_ACTION, EXPIRE_NEVER);
  checkPolicyPermission("Changing with a non-policy expire type is rejected");

  pm.removeAll();
});

add_task(function test_policy_permission_policy_caller() {
  addPolicyPermission();

  pm.addFromPrincipal(principal, "cookie", DENY_ACTION, EXPIRE_POLICY);
  Assert.equal(
    pm.testPermissionFromPrincipal(principal, "cookie"),
    DENY_ACTION,
    "Changing with EXPIRE_POLICY is allowed"
  );

  pm.addFromPrincipal(principal, "cookie", UNKNOWN_ACTION, EXPIRE_POLICY);
  Assert.equal(
    pm.getPermissionObject(principal, "cookie", true),
    null,
    "Removing with EXPIRE_POLICY is allowed"
  );
});
