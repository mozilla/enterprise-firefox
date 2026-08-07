/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { ConsoleClient } = ChromeUtils.importESModule(
  "resource://gre/modules/enterprise/ConsoleClient.sys.mjs"
);

// Name the wasm module has as a test support-file.
const WASM_PATH = "content_analysis_wasm.wasm";

// The ContentAnalysisWasm process actor is normally registered at browser
// startup (via ActorManagerParent/DesktopActorRegistry), which does not run in
// xpcshell, so register it here.
try {
  ChromeUtils.registerProcessActor("ContentAnalysisWasm", {
    parent: {
      esModuleURI: "resource://gre/modules/ContentAnalysisWasmParent.sys.mjs",
    },
    child: {
      esModuleURI: "resource://gre/modules/ContentAnalysisWasmChild.sys.mjs",
    },
    remoteTypes: ["privilegedabout"],
  });
} catch (e) {
  if (e.name !== "NotSupportedError") {
    throw e;
  }
}

// Stub ConsoleClient's DLP wasm endpoints to serve the module bundled under
// WASM_PATH as the given version, standing in for the real console.
async function stubDlpWasmModule(version = "1.0") {
  const moduleBytes = await IOUtils.read(do_get_file(WASM_PATH).path);
  ConsoleClient.getDlpWasmModuleVersion = async () => version;
  ConsoleClient.getDlpWasmModule = async () => moduleBytes.buffer;
}
