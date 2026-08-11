/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Parent-process driver for the in-process WebAssembly DLP module. Called by the
 * C++ WasmModuleBackend, which passes a serialized ContentAnalysisRequest and
 * expects a serialized ContentAnalysisResponse back.
 *
 * This runs in the parent process so it cannot compile or run the module -
 * that work is done by the ContentAnalysisWasm actor.
 *
 * The module is fetched from the console once, on the first call to
 * ensureModuleReady() (from WasmModuleBackend::EnsureReady() at startup, or
 * from analyze() if that races it), and reused for the runner's lifetime.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  ConsoleClient: "resource://gre/modules/enterprise/ConsoleClient.sys.mjs",
  E10SUtils: "resource://gre/modules/E10SUtils.sys.mjs",
});

const ACTOR_NAME = "ContentAnalysisWasm";

/**
 * nsIContentAnalysisWasmRunner implementation. See the module comment above.
 */
export class ContentAnalysisWasmRunner {
  QueryInterface = ChromeUtils.generateQI(["nsIContentAnalysisWasmRunner"]);

  // In-memory cache of the module fetched from the console.
  #cachedVersion = null;
  #cachedModuleBytes = null;

  // The in-flight (or settled) fetch of the module. Cleared on failure so
  // a later call will retry.
  #modulePromise = null;

  get cachedModuleVersion() {
    return this.#cachedVersion ?? "(unknown)";
  }

  async analyze(aRequestBytes, aContentBytes, aRules) {
    const { moduleBytes, version } = await this.ensureModuleReady();

    const actor = await this.#getActor();
    // Resolves with a Uint8Array, which the C++ caller reads in bulk.
    return actor.sendQuery("Analyze", {
      version,
      moduleBytes,
      requestBytes: Uint8Array.from(aRequestBytes),
      contentBytes: Uint8Array.from(aContentBytes || []),
      rules: toPlainRules(aRules),
    });
  }

  /**
   * Ensures the module has been fetched from the console. Safe to call
   * redundantly.
   *
   * @returns {Promise<{moduleBytes: Uint8Array, version: string}>}
   */
  ensureModuleReady() {
    if (!this.#modulePromise) {
      this.#modulePromise = this.#fetchModule().catch(e => {
        this.#modulePromise = null;
        throw e;
      });
    }
    return this.#modulePromise;
  }

  async #fetchModule() {
    const version = await lazy.ConsoleClient.getDlpWasmModuleVersion();
    const buffer = await lazy.ConsoleClient.getDlpWasmModule();
    this.#cachedModuleBytes = new Uint8Array(buffer);
    this.#cachedVersion = version;
    return {
      moduleBytes: this.#cachedModuleBytes,
      version: this.#cachedVersion,
    };
  }

  async #getActor() {
    // We use the privilegedabout process for this because:
    // - it's essentially always running, so it won't add any overhead
    // - it has the ability to compile and run WASM
    const keepAlive = await ChromeUtils.ensureHeadlessContentProcess(
      lazy.E10SUtils.PRIVILEGEDABOUT_REMOTE_TYPE
    );
    if (!keepAlive?.domProcess?.canSend) {
      throw Components.Exception(
        "could not start a content process for the DLP wasm module",
        Cr.NS_ERROR_NOT_AVAILABLE
      );
    }
    return keepAlive.domProcess.getActor(ACTOR_NAME);
  }
}

// Convert the C++-supplied nsIContentAnalysisRule objects into plain,
// structured-cloneable objects to ship to the content process.
function toPlainRules(aRules) {
  return Array.from(aRules || [], rule => ({
    name: rule.name,
    operations: Array.from(rule.operations),
    domains: Array.from(rule.domains),
    contentPatterns: Array.from(rule.contentPatterns),
    ruleType: rule.verdict,
    message: rule.message,
  }));
}
