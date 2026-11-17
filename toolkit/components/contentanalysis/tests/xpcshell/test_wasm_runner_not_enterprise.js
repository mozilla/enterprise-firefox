/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_task(async function test_module_unavailable_without_enterprise() {
  const runner = Cc[
    "@mozilla.org/contentanalysis/wasm-runner;1"
  ].createInstance(Ci.nsIContentAnalysisWasmRunner);
  await Assert.rejects(
    runner.ensureModuleReady(),
    e => e.result == Cr.NS_ERROR_NOT_AVAILABLE,
    "ensureModuleReady rejects with NS_ERROR_NOT_AVAILABLE"
  );
  Assert.equal(runner.cachedModuleVersion, "", "no module cached");
});
