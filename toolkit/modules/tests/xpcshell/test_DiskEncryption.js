/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

const { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);
const { MockRegistrar } = ChromeUtils.importESModule(
  "resource://testing-common/MockRegistrar.sys.mjs"
);

const enterpriseOnly = () => ({ skip_if: () => !AppConstants.MOZ_ENTERPRISE });

const CONTRACT_ID = "@mozilla.org/enterprise/disk-encryption-checker;1";
const VALID_STATUSES = [
  "full",
  "enabled",
  "partial",
  "disabled",
  "in-progress",
  "unknown",
];

let DiskEncryption;
if (AppConstants.MOZ_ENTERPRISE) {
  ({ DiskEncryption } = ChromeUtils.importESModule(
    "resource://gre/modules/enterprise/DiskEncryption.sys.mjs"
  ));
}

async function withMockChecker(mock, callback) {
  let cid = MockRegistrar.register(CONTRACT_ID, {
    QueryInterface: ChromeUtils.generateQI([Ci.nsIDiskEncryptionChecker]),
    ...mock,
  });
  try {
    await callback();
  } finally {
    MockRegistrar.unregister(cid);
  }
}

add_task(enterpriseOnly(), async function test_native_component_result_shape() {
  let result = await DiskEncryption.getStatus();
  info(`Disk encryption: ${JSON.stringify(result)}`);

  Assert.ok(
    VALID_STATUSES.includes(result.status),
    `${result.status} is a documented status`
  );
  Assert.equal(
    result.method === null,
    result.status === "unknown",
    "a method is reported unless the status is unknown"
  );
  if (result.method !== null) {
    Assert.ok(
      {
        macosx: ["filevault"],
        win: ["bitlocker"],
        // A ZFS root reports native encryption rather than dm-crypt.
        linux: ["dm-crypt", "zfs"],
      }[AppConstants.platform].includes(result.method),
      `${result.method} is a method of this platform`
    );
  }
});

add_task(enterpriseOnly(), async function test_empty_method_becomes_null() {
  await withMockChecker(
    {
      getDiskEncryption(callback) {
        callback.onComplete("unknown", "");
      },
    },
    async () => {
      Assert.deepEqual(await DiskEncryption.getStatus(), {
        status: "unknown",
        method: null,
      });
    }
  );
});

add_task(
  enterpriseOnly(),
  async function test_invalid_result_becomes_unknown() {
    for (let [status, method] of [
      ["unexpected", "dm-crypt"],
      ["full", ""],
      ["full", "unexpected"],
      ["unknown", "dm-crypt"],
    ]) {
      await withMockChecker(
        {
          getDiskEncryption(callback) {
            callback.onComplete(status, method);
          },
        },
        async () => {
          Assert.deepEqual(
            await DiskEncryption.getStatus(),
            { status: "unknown", method: null },
            `${status}/${method} is normalized to unknown`
          );
        }
      );
    }
  }
);

add_task(enterpriseOnly(), async function test_lost_callback_times_out() {
  await withMockChecker(
    {
      getDiskEncryption() {},
    },
    async () => {
      Assert.deepEqual(
        await DiskEncryption.getStatus(50),
        { status: "unknown", method: null },
        "A missing callback resolves to unknown"
      );
    }
  );
});

add_task(enterpriseOnly(), async function test_failing_component_is_unknown() {
  await withMockChecker(
    {
      getDiskEncryption() {
        throw Components.Exception("", Cr.NS_ERROR_FAILURE);
      },
    },
    async () => {
      Assert.deepEqual(await DiskEncryption.getStatus(), {
        status: "unknown",
        method: null,
      });
    }
  );
});
