/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Bug 1991914: Felt flags are detected with the same CheckArg parsing as the
// rest of the command line.

const { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);
const { Subprocess } = ChromeUtils.importESModule(
  "resource://gre/modules/Subprocess.sys.mjs"
);

const FELT_CONNECT_ERROR = "Error: Failed to connect to Felt.";

function browserBinary() {
  const file = Services.dirsvc.get("GreBinD", Ci.nsIFile);
  file.append(AppConstants.MOZ_APP_NAME);
  return file.path;
}

async function runBrowser(args) {
  const profileDir = await IOUtils.createUniqueDirectory(
    PathUtils.tempDir,
    "felt-flags"
  );
  try {
    const proc = await Subprocess.call({
      command: browserBinary(),
      arguments: ["-profile", profileDir, ...args],
      environment: { MOZ_BYPASS_FELT: "", MOZ_FELT_UI: "" },
      environmentAppend: true,
      stderr: "pipe",
    });
    let stderr = "";
    for (let chunk; (chunk = await proc.stderr.readString()); ) {
      stderr += chunk;
    }
    const { exitCode } = await proc.wait();
    return { exitCode, stderr };
  } finally {
    await IOUtils.remove(profileDir, { recursive: true });
  }
}

add_task(async function test_felt_flag_forms_select_browser_mode() {
  for (const args of [
    ["-felt", "bogus-socket"],
    ["--FELT", "bogus-socket"],
    ["--felt=bogus-socket"],
  ]) {
    const { exitCode, stderr } = await runBrowser(args);
    Assert.equal(exitCode, 1, `${args} should exit with an error`);
    Assert.stringContains(
      stderr,
      FELT_CONNECT_ERROR,
      `${args} should start in Felt browser mode`
    );
  }
});

add_task(async function test_malformed_or_value_args_are_not_felt_flags() {
  for (const args of [
    ["-felt", "bogus-socket", "----felt----ui"],
    ["-felt", "bogus-socket", "-url", "chrome"],
  ]) {
    const { exitCode, stderr } = await runBrowser(args);
    Assert.equal(exitCode, 1, `${args} should exit with an error`);
    Assert.stringContains(
      stderr,
      FELT_CONNECT_ERROR,
      `${args} should stay in Felt browser mode`
    );
  }
});
