/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Content-process half of the content-analysis WebAssembly runner. This actor
 * runs the module in a null-principal sandbox so that compiling it is permitted.
 */

const SANDBOX_SCRIPT =
  "resource://gre/modules/content-analysis-wasm-sandbox.js";

/**
 * Compiles and runs the DLP module in a null-principal sandbox.
 */
export class ContentAnalysisWasmChild extends JSProcessActorChild {
  // The null-principal sandbox that hosts the compiled module, created lazily
  // and reused across requests.
  #sandbox = null;
  // Version of the module currently compiled in the sandbox, so we only recompile
  // when the parent switches to a different version.
  #loadedVersion = null;

  #ensureSandbox() {
    if (!this.#sandbox) {
      const principal = Services.scriptSecurityManager.createNullPrincipal({});
      const sandbox = Cu.Sandbox(principal, {
        wantGlobalProperties: ["TextEncoder"],
        sandboxName: "content-analysis-wasm",
      });
      Services.scriptloader.loadSubScript(SANDBOX_SCRIPT, sandbox);
      this.#sandbox = sandbox;
    }
    return this.#sandbox;
  }

  // The analyses in progress, so that a "Cancel" message can stop them. Each is
  // { userActionId, canceled, readers }, where readers holds the stream readers
  // it is currently reading from.
  #analyses = new Set();

  receiveMessage(message) {
    switch (message.name) {
      case "Analyze":
        return this.#analyze(message.data);
      case "Cancel":
        this.#cancel(message.data.userActionId);
        return undefined;
    }
    return undefined;
  }

  // Analyses run concurrently, so that one whose data is slow to arrive (e.g.
  // a file on a stalled network share) doesn't hold up the others; only their
  // synchronous calls into the module are serialized.
  async #analyze({
    userActionId,
    version,
    moduleBytes,
    request,
    content,
    rules,
  }) {
    const sandbox = this.#ensureSandbox();

    // Recompile only when the module changed since the last request.
    if (this.#loadedVersion !== version) {
      sandbox.loadModule(Cu.cloneInto(moduleBytes, sandbox));
      this.#loadedVersion = version;
    }

    const analysis = { userActionId, canceled: false, readers: new Set() };
    this.#analyses.add(analysis);
    let id = 0;
    try {
      id = sandbox.beginAnalyze(request.size, content ? content.size : 0);
      await this.#writeBlob(sandbox, analysis, id, "request", request);
      if (content) {
        await this.#writeBlob(sandbox, analysis, id, "content", content);
      }
      const responseBytes = sandbox.finishAnalyze(
        id,
        Cu.cloneInto({ rules }, sandbox)
      );
      // Bulk-copy out of the sandbox compartment into a Uint8Array of our own,
      // which IPC structured-clones and C++ reads directly.
      return new Uint8Array(responseBytes);
    } finally {
      if (id) {
        sandbox.abortAnalyze(id);
      }
      this.#analyses.delete(analysis);
    }
  }

  // Stop every analysis for aUserActionId, which has been canceled or has timed
  // out, releasing its buffers instead of waiting for its data to arrive.
  #cancel(aUserActionId) {
    for (const analysis of this.#analyses) {
      if (analysis.userActionId === aUserActionId) {
        analysis.canceled = true;
        for (const reader of analysis.readers) {
          reader.cancel().catch(() => {});
        }
      }
    }
  }

  // Stream aBlob into the sandbox buffer aBufferName of analysis aId one chunk
  // at a time, so the data is never held in full outside the module's memory.
  // For a file, the blob's size is the file's size when the request was made;
  // if the file has since grown or shrunk, analyzing only part of it, or a
  // buffer that is partly unwritten, could miss content, so that is an error.
  async #writeBlob(sandbox, analysis, aId, aBufferName, aBlob) {
    const size = aBlob.size;
    const reader = aBlob.stream().getReader();
    analysis.readers.add(reader);
    let offset = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (analysis.canceled) {
          throw new Error("DLP wasm analysis was canceled");
        }
        if (done) {
          break;
        }
        if (value.length > size - offset) {
          throw new Error(`DLP ${aBufferName} is larger than expected`);
        }
        sandbox.writeBytes(
          aId,
          aBufferName,
          offset,
          Cu.cloneInto(value, sandbox)
        );
        offset += value.length;
      }
      if (offset !== size) {
        throw new Error(`DLP ${aBufferName} is smaller than expected`);
      }
    } finally {
      analysis.readers.delete(reader);
      reader.cancel().catch(() => {});
    }
  }
}
