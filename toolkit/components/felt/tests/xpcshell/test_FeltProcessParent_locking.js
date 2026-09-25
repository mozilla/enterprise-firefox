/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { FeltProcessParent } = ChromeUtils.importESModule(
  "chrome://felt/content/FeltProcessParent.sys.mjs"
);
const { FeltLocking } = ChromeUtils.importESModule(
  "chrome://felt/content/FeltLocking.sys.mjs"
);
const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);

add_task(async function test_lock_persists_after_expected_drain() {
  const store = sinon.stub(FeltLocking, "store").resolves();
  const actor = {
    loggedInUserInfo: { id: "user-123" },
    logoutReported: false,
    _drainPendingRefresh: FeltProcessParent.prototype._drainPendingRefresh,
  };
  try {
    Assert.ok(
      await FeltProcessParent.prototype._persistLockedSession.call(actor),
      "The drain's own generation change does not cancel locking."
    );
    Assert.ok(store.calledOnce);
    Assert.ok(actor.logoutReported);
  } finally {
    store.restore();
  }
});

add_task(async function test_lock_rejects_extra_teardown_during_drain() {
  const store = sinon.stub(FeltLocking, "store").resolves();
  const actor = {
    loggedInUserInfo: { id: "user-123" },
    logoutReported: false,
    async _drainPendingRefresh() {
      await FeltProcessParent.prototype._drainPendingRefresh.call(this);
      await FeltProcessParent.prototype._drainPendingRefresh.call(this);
    },
  };
  try {
    Assert.ok(
      !(await FeltProcessParent.prototype._persistLockedSession.call(actor)),
      "An extra generation change prevents a stale lock."
    );
    Assert.ok(store.notCalled);
  } finally {
    store.restore();
  }
});
