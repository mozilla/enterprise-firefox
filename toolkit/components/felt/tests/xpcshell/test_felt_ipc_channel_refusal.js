/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Bug 2072053: when felt refuses the IPC peer, the one-shot endpoint is gone,
// so the spawned browser must be terminated rather than left starting with a
// released endpoint name that another process could claim.

const { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);
const { openIpcChannelOrTerminate, parseAnnouncedBrowserPid } =
  ChromeUtils.importESModule("chrome://felt/content/FeltProcessParent.sys.mjs");
const { Subprocess } = ChromeUtils.importESModule(
  "resource://gre/modules/Subprocess.sys.mjs"
);
const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);

function fakeProc() {
  return {
    killedWith: [],
    kill(timeout) {
      this.killedWith.push(timeout);
      return Promise.resolve({ exitCode: -9 });
    },
  };
}

function browserBinary() {
  const file = Services.dirsvc.get("GreBinD", Ci.nsIFile);
  file.append(
    AppConstants.platform == "win"
      ? AppConstants.MOZ_APP_NAME + ".exe"
      : AppConstants.MOZ_APP_NAME
  );
  return file.path;
}

// Resolves with the browser pid the Windows launcher process announces on
// stdout, or null if stdout closes first.
async function readAnnouncedBrowserPid(proc) {
  let output = "";
  for (let chunk; (chunk = await proc.stdout.readString()); ) {
    output += chunk;
    const completeLines = output.split("\n").slice(0, -1);
    for (const line of completeLines) {
      const pid = parseAnnouncedBrowserPid(line);
      if (pid !== null) {
        return pid;
      }
    }
  }
  return null;
}

async function isWindowsProcessRunning(pid) {
  const tasklistExe = Services.dirsvc.get("SysD", Ci.nsIFile);
  tasklistExe.append("tasklist.exe");
  const tasklist = await Subprocess.call({
    command: tasklistExe.path,
    arguments: ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
  });
  let output = "";
  for (let chunk; (chunk = await tasklist.stdout.readString()); ) {
    output += chunk;
  }
  await tasklist.wait();
  return output.includes(`"${pid}"`);
}

add_task(async function test_refused_peer_terminates_the_browser() {
  const proc = fakeProc();
  const refusal = new Error("refused");
  await Assert.rejects(
    openIpcChannelOrTerminate(proc, () => {
      throw refusal;
    }),
    e => e === refusal,
    "the refusal is rethrown for the launch failure path"
  );
  Assert.deepEqual(proc.killedWith, [0], "the browser is force-killed");
});

add_task(async function test_accepted_peer_leaves_the_browser_running() {
  const proc = fakeProc();
  let opened = false;
  await openIpcChannelOrTerminate(proc, () => {
    opened = true;
  });
  Assert.ok(opened, "the channel was opened");
  Assert.deepEqual(proc.killedWith, [], "the browser is not killed");
});

// The real browser binary connects to the endpoint, but felt expects this
// process's pid, so ipcChannel() must refuse the browser and the browser must
// be terminated. The browser is told to expect this process, so it does connect. ipcChannel() blocks until the browser connects. On Windows the
// browser is started as felt starts it, through a launcher process that runs
// it as a child, so the child must be gone too.
add_task(
  async function test_ipc_channel_refuses_and_terminates_the_real_browser() {
    const isWindows = AppConstants.platform == "win";
    const endpoint = Services.felt.oneShotIpcServer();
    const profileDir = await IOUtils.createUniqueDirectory(
      PathUtils.tempDir,
      "felt-refusal-profile"
    );
    const launcherArgs = isWindows
      ? ["--launcher", "--wait-for-browser", "--no-deelevate"]
      : [];
    const proc = await Subprocess.call({
      command: browserBinary(),
      arguments: [
        ...launcherArgs,
        "--foreground",
        "-profile",
        profileDir,
        "-felt",
        endpoint,
        "-feltPid",
        String(Services.appinfo.processID),
      ],
      environment: { MOZ_BYPASS_FELT: "", MOZ_FELT_UI: "" },
      environmentAppend: true,
    });
    registerCleanupFunction(async () => {
      await proc.kill();
      await IOUtils.remove(profileDir, { recursive: true });
    });
    const announcedBrowserPid = isWindows
      ? readAnnouncedBrowserPid(proc)
      : null;

    await Assert.rejects(
      openIpcChannelOrTerminate(proc, () =>
        Services.felt.ipcChannel(Services.appinfo.processID, 1)
      ),
      e => e.result == Cr.NS_ERROR_PORT_ACCESS_NOT_ALLOWED,
      "ipcChannel() refuses a peer that is not the expected process"
    );
    Assert.notStrictEqual(
      proc.exitCode,
      null,
      "the spawned process has exited"
    );

    if (isWindows) {
      const browserPid = await announcedBrowserPid;
      Assert.ok(browserPid, "the launcher announced the browser pid");
      Assert.ok(
        await isWindowsProcessRunning(Services.appinfo.processID),
        "tasklist lists a running process"
      );
      await TestUtils.waitForCondition(
        async () => !(await isWindowsProcessRunning(browserPid)),
        "the browser child has exited"
      );
    }
  }
);
