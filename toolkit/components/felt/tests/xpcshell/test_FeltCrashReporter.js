/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { FeltCrashReporter } = ChromeUtils.importESModule(
  "resource://gre/modules/enterprise/FeltCrashReporter.sys.mjs"
);

do_get_profile();

let gDirCount = 0;

/**
 * Services.felt only exists on enterprise builds and is not registered in the
 * xpcshell runner, so install a fake for the token lookup in report().
 *
 * @param {string} [token] - what getAccessTokenIfValid() should return
 * @returns {Disposable} restores the previous value
 */
/* eslint-disable mozilla/valid-services */
function installFakeFelt(token = "test-token") {
  const had = Object.prototype.hasOwnProperty.call(Services, "felt");
  const prev = had ? Services.felt : undefined;
  Object.defineProperty(Services, "felt", {
    value: { getAccessTokenIfValid: () => token },
    configurable: true,
    writable: true,
  });
  return {
    [Symbol.dispose]() {
      if (had) {
        Services.felt = prev;
      } else {
        delete Services.felt;
      }
    },
  };
}
/* eslint-enable mozilla/valid-services */

/**
 * Build a minidumps directory populated with the given dumps.
 *
 * @param {object[]} dumps - Each entry is {name, age, extra}. `age` is how many
 *                   milliseconds before now the dump was last modified, and
 *                   `extra` is the .extra contents, or null for no .extra file.
 * @returns {Promise<{profilePath: string, now: number}>}
 */
async function makeProfile(dumps) {
  const profilePath = PathUtils.join(
    PathUtils.tempDir,
    `felt-crash-${gDirCount++}`
  );
  const minidumpsDir = PathUtils.join(profilePath, "minidumps");
  await IOUtils.makeDirectory(minidumpsDir, { createAncestors: true });

  const now = Date.now();
  for (const { name, age, extra } of dumps) {
    const dumpPath = PathUtils.join(minidumpsDir, `${name}.dmp`);
    await IOUtils.writeUTF8(dumpPath, "minidump");
    await IOUtils.setModificationTime(dumpPath, now - age);
    if (extra !== null) {
      await IOUtils.writeJSON(
        PathUtils.join(minidumpsDir, `${name}.extra`),
        extra
      );
    }
  }

  return { profilePath, now };
}

add_task(async function test_picks_newest_dump() {
  const { profilePath, now } = await makeProfile([
    { name: "old", age: 5000, extra: {} },
    { name: "new", age: 1000, extra: {} },
  ]);

  const found = await FeltCrashReporter._findMinidump(profilePath, now - 10000);
  Assert.equal(
    PathUtils.filename(found.path),
    "new.dmp",
    "picks the most recently modified dump"
  );
});

add_task(async function test_ignores_dump_without_extra() {
  const { profilePath, now } = await makeProfile([
    { name: "complete", age: 5000, extra: {} },
    { name: "partial", age: 1000, extra: null },
  ]);

  const found = await FeltCrashReporter._findMinidump(profilePath, now - 10000);
  Assert.equal(
    PathUtils.filename(found.path),
    "complete.dmp",
    "a dump whose .extra has not been written yet is skipped"
  );
});

add_task(async function test_ignores_dump_older_than_launch() {
  const { profilePath, now } = await makeProfile([
    { name: "previous-run", age: 60000, extra: {} },
  ]);

  const found = await FeltCrashReporter._findMinidump(profilePath, now - 5000);
  Assert.equal(found, null, "a dump predating the browser launch is ignored");
});

add_task(async function test_no_minidumps_directory() {
  const profilePath = PathUtils.join(PathUtils.tempDir, "felt-crash-empty");
  await IOUtils.makeDirectory(profilePath, { createAncestors: true });

  const found = await FeltCrashReporter._findMinidump(profilePath, 0);
  Assert.equal(found, null, "a profile with no minidumps directory is handled");
});

add_task(async function test_policy_gating() {
  const cases = [
    { extra: { EnterpriseCrashReportsSubmit: "0" }, disabled: true },
    { extra: { EnterpriseCrashReportsSubmit: "1" }, disabled: false },
    { extra: {}, disabled: false },
  ];

  for (const { extra, disabled } of cases) {
    const { profilePath, now } = await makeProfile([
      { name: "crash", age: 1000, extra },
    ]);
    const { path: dumpPath } = await FeltCrashReporter._findMinidump(
      profilePath,
      now - 10000
    );
    Assert.equal(
      await FeltCrashReporter._isDisabledByPolicy(dumpPath),
      disabled,
      `EnterpriseCrashReportsSubmit=${extra.EnterpriseCrashReportsSubmit} gates correctly`
    );
  }
});

add_task(async function test_unreadable_extra_does_not_block_reporting() {
  const { profilePath } = await makeProfile([]);
  const dumpPath = PathUtils.join(profilePath, "minidumps", "missing.dmp");

  Assert.ok(
    !(await FeltCrashReporter._isDisabledByPolicy(dumpPath)),
    "a missing .extra leaves reporting enabled rather than silently dropping the crash"
  );
});

add_task(async function test_report_honours_no_report_env() {
  const { profilePath, now } = await makeProfile([
    { name: "crash", age: 1000, extra: {} },
  ]);

  // The xpcshell harness sets MOZ_CRASHREPORTER_NO_REPORT itself, so assert
  // both directions rather than trusting the ambient value. Stubbing the lookup
  // both proves how far report() got and keeps us from spawning a real client.
  const realFindMinidump = FeltCrashReporter._findMinidump;
  const previous = Services.env.get("MOZ_CRASHREPORTER_NO_REPORT");
  let lookedForDump = false;
  FeltCrashReporter._findMinidump = async () => {
    lookedForDump = true;
    return null;
  };

  try {
    Services.env.set("MOZ_CRASHREPORTER_NO_REPORT", "1");
    Assert.ok(
      !(await FeltCrashReporter.report(profilePath, now - 10000)),
      "MOZ_CRASHREPORTER_NO_REPORT stops us launching the client"
    );
    Assert.ok(!lookedForDump, "we bail out before even looking for a minidump");

    Services.env.set("MOZ_CRASHREPORTER_NO_REPORT", "");
    await FeltCrashReporter.report(profilePath, now - 10000);
    Assert.ok(lookedForDump, "without it set we go on to look for a minidump");
  } finally {
    FeltCrashReporter._findMinidump = realFindMinidump;
    Services.env.set("MOZ_CRASHREPORTER_NO_REPORT", previous);
  }
});

add_task(async function test_already_reported_dump_is_not_picked_up_again() {
  // A crash loop restarts the browser within the mtime slack, so the previous
  // run's dump is still a candidate. Once reported it must never come back,
  // even though the client may not have moved it out of the profile yet.
  const { profilePath, now } = await makeProfile([
    { name: "crash", age: 1000, extra: {} },
  ]);

  const first = await FeltCrashReporter._findMinidump(profilePath, now - 10000);
  Assert.equal(
    PathUtils.filename(first.path),
    "crash.dmp",
    "the dump is found the first time"
  );

  // eslint-disable-next-line no-unused-vars
  using _felt = installFakeFelt();
  const realLaunch = FeltCrashReporter._launch;
  const previous = Services.env.get("MOZ_CRASHREPORTER_NO_REPORT");
  let launched = 0;
  FeltCrashReporter._launch = async () => {
    launched++;
  };

  try {
    Services.env.set("MOZ_CRASHREPORTER_NO_REPORT", "");
    Assert.ok(
      await FeltCrashReporter.report(profilePath, now - 10000),
      "the crash is reported"
    );
    Assert.equal(launched, 1, "the client was launched once");

    Assert.ok(
      !(await FeltCrashReporter.report(profilePath, now - 10000)),
      "a second attempt over the same directory reports nothing"
    );
    Assert.equal(launched, 1, "the client was not launched again");
  } finally {
    FeltCrashReporter._launch = realLaunch;
    Services.env.set("MOZ_CRASHREPORTER_NO_REPORT", previous);
  }

  Assert.equal(
    await FeltCrashReporter._findMinidump(profilePath, now - 10000),
    null,
    "the reported dump is filtered out by the high-water mark"
  );
});

add_task(async function test_report_without_profile_path() {
  Assert.ok(
    !(await FeltCrashReporter.report(null, 0)),
    "a browser with no known profile path is handled"
  );
});
