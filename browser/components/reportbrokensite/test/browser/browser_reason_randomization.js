/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

/* Tests to ensure that the reason dropdown is shown or hidden
 * based on its pref, and that its optional and required modes affect
 * the Send button and report appropriately.
 */

"use strict";

add_common_setup();

add_task(async function testReasonDropdownRandomized() {
  ensureReportBrokenSitePreffedOn();

  const USER_ID_PREF = "app.normandy.user_id";
  const RANDOMIZE_PREF = "ui.new-webcompat-reporter.reason-dropdown.randomized";

  const origNormandyUserID = Services.prefs.getCharPref(
    USER_ID_PREF,
    undefined
  );

  await withNewTab(REPORTABLE_PAGE_URL, async () => {
    // confirm that the default order is used with the pref off
    Services.prefs.setBoolPref(RANDOMIZE_PREF, false);
    const rbs = await AppMenu().openReportBrokenSite();

    const getCurrentReasonOrder = () =>
      rbs.reasonButtons.map(r =>
        r.id.replace("report-broken-site-popup-reason-", "")
      );

    const defaultOrder = [
      "checkout",
      "load",
      "slow",
      "media",
      "content",
      "account",
      "adblocker",
      "notsupported",
      "deceptive",
      "other",
    ];
    Assert.deepEqual(
      getCurrentReasonOrder(),
      defaultOrder,
      "non-random order is correct"
    );

    // confirm that toggling the pref randomizes the order.
    Services.prefs.setBoolPref(RANDOMIZE_PREF, true);
    const ensureDifferentOrderThan = async (comparison, reopen) => {
      for (let attempt = 0; attempt < 5; ++attempt) {
        if (reopen) {
          await rbs.clickReason("load");
          await rbs.clickCancel();
          await AppMenu().openReportBrokenSite();
        }
        const order = getCurrentReasonOrder();
        if (JSON.stringify(order) != JSON.stringify(comparison)) {
          return order;
        }
      }
      return undefined;
    };
    const newOrder = await ensureDifferentOrderThan(defaultOrder);
    ok(newOrder, "order randomizes if pref is true");

    // confirm that a random order happens per user
    Services.prefs.setBoolPref(RANDOMIZE_PREF, true);

    // This becomes ClientEnvironment.randomizationId, which we can set to
    // any value which results in a different order from the default ordering.
    Services.prefs.setCharPref("app.normandy.user_id", "dummy");

    const newUserOrder = getCurrentReasonOrder();
    Assert.notEqual(
      newUserOrder,
      newOrder,
      "options are randomized with pref on"
    );

    // confirm that the order doesn't change just by re-opening the menu.
    const reopenedOrder = await ensureDifferentOrderThan(newUserOrder);
    ok(
      !reopenedOrder,
      "options keep the same order if panel is merely reopened"
    );

    // confirm that the order reverts to the default if pref flipped to false
    Services.prefs.setBoolPref(RANDOMIZE_PREF, false);
    Assert.deepEqual(
      defaultOrder,
      getCurrentReasonOrder(),
      "reverts to non-random order correctly"
    );

    rbs.close();
  });

  Services.prefs.setCharPref(USER_ID_PREF, origNormandyUserID);
});
