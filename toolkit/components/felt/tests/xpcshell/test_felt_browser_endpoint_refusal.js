/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Bug 2073022: a felt browser only completes the IPC handshake with the felt
// process named on its command line. Started with no felt pid, an invalid one,
// or one that does not own the endpoint, the real browser binary must exit
// with status 1 before it does anything else.

const { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);
const { Subprocess } = ChromeUtils.importESModule(
  "resource://gre/modules/Subprocess.sys.mjs"
);
function browserBinary() {
  const file = Services.dirsvc.get("GreBinD", Ci.nsIFile);
  file.append(
    AppConstants.platform == "win"
      ? AppConstants.MOZ_APP_NAME + ".exe"
      : AppConstants.MOZ_APP_NAME
  );
  return file.path;
}

// Starts the browser binary with the given felt arguments, lets `afterSpawn`
// act as the endpoint if needed, and returns the exit code and stderr. A
// browser that does not exit is killed at cleanup, after the harness timeout
// fails the test.
async function launchBrowser(args, afterSpawn = () => {}) {
  const proc = await Subprocess.call({
    command: browserBinary(),
    arguments: ["--foreground", ...args],
    stderr: "pipe",
    environment: { MOZ_BYPASS_FELT: "", MOZ_FELT_UI: "" },
    environmentAppend: true,
  });
  registerCleanupFunction(() => proc.kill());
  afterSpawn(proc);
  let stderr = "";
  for (let chunk; (chunk = await proc.stderr.readString()); ) {
    stderr += chunk;
  }
  await proc.exitPromise;
  return { exitCode: proc.exitCode, stderr };
}

function assertRefused({ exitCode, stderr }, reason, message) {
  Assert.equal(exitCode, 1, `${message}: exit code`);
  Assert.ok(stderr.includes(reason), `${message}: stderr says why: ${stderr}`);
}

add_task(async function test_missing_felt_pid_exits() {
  assertRefused(
    await launchBrowser(["-felt", "unused-endpoint-name"]),
    "requires the Felt process id",
    "no felt pid"
  );
});

add_task(async function test_invalid_felt_pid_exits() {
  for (const pid of ["0", "4294967296"]) {
    assertRefused(
      await launchBrowser(["-felt", "unused-endpoint-name", "-feltPid", pid]),
      "invalid Felt process id",
      `-feltPid ${pid}`
    );
  }
  // A value that is not a number does not parse as an argument at all.
  assertRefused(
    await launchBrowser([
      "-felt",
      "unused-endpoint-name",
      "-feltPid",
      "notapid",
    ]),
    "requires the Felt process id",
    "-feltPid notapid"
  );
});

// The endpoint is owned by this process, but the browser is told to expect
// another pid, so it must refuse it. Everywhere but macOS the browser decides
// before sending anything, so the endpoint is never read. On macOS the browser
// decides from the reply, so the endpoint must accept and answer, which
// ipcChannel does for the spawned pid; whether ipcChannel itself then fails
// depends on whether the browser has already dropped its end, so only the
// browser's outcome is asserted.
add_task(async function test_endpoint_of_another_pid_is_refused() {
  const endpoint = Services.felt.oneShotIpcServer();
  const args = [
    "-felt",
    endpoint,
    "-feltPid",
    String(Services.appinfo.processID + 1),
  ];
  const result = await launchBrowser(args, proc => {
    if (AppConstants.platform == "macosx") {
      try {
        Services.felt.ipcChannel(proc.pid, 1);
      } catch (e) {
        info(`ipcChannel failed after answering the browser: ${e}`);
      }
    }
  });
  assertRefused(result, "Failed to connect to Felt", "endpoint of another pid");
});
