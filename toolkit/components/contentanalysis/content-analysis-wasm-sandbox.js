/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// Compiles and runs the in-process WebAssembly DLP module. This script is loaded
// (via loadSubScript) into a null-principal sandbox living in a privilegedabout
// process by ContentAnalysisWasmChild.
//
// The sandbox has no chrome privileges (Cc/Ci/Components are unavailable), so
// failures are reported with plain Errors; the child actor turns them into the
// runner's callback.onError.

// The wasm module's exported ABI contract:
//   ca_abi_version() -> i32
//   ca_alloc(len) -> ptr ; ca_free(ptr, len)
//   ca_analyze(reqPtr, reqLen, contentPtr, contentLen,
//              rulesPtr, rulesCount, outLenPtr) -> respPtr
const ABI_VERSION = 1;

// Layout of the module's `#[repr(C)]` rule structs on wasm32 (4-byte pointers and
// usize). Must match content-analysis-wasm's FfiStr/FfiRule exactly.
//   FfiStr  { ptr: u32, len: u32 }                              // 8 bytes
//   FfiRule { name: FfiStr,             // @0
//             operations: u32,          // @8  (ptr to u32 array)
//             operations_count: u32,    // @12
//             domains: u32,             // @16 (ptr to FfiStr array)
//             domains_count: u32,       // @20
//             content_patterns: u32,    // @24 (ptr to FfiStr array)
//             patterns_count: u32,      // @28
//             rule_type: u8,            // @32 (0=report, 1=warn, 2=block)
//             message: FfiStr }         // @36
const FFI_STR_SIZE = 8;
const FFI_RULE_SIZE = 44;
const FFI_RULE_OPERATIONS_OFFSET = 8;
const FFI_RULE_OPERATIONS_COUNT_OFFSET = 12;
const FFI_RULE_DOMAINS_OFFSET = 16;
const FFI_RULE_DOMAINS_COUNT_OFFSET = 20;
const FFI_RULE_PATTERNS_OFFSET = 24;
const FFI_RULE_PATTERNS_COUNT_OFFSET = 28;
const FFI_RULE_TYPE_OFFSET = 32;
const FFI_RULE_MESSAGE_OFFSET = 36;

// The currently loaded module instance, kept across analyze() calls so the
// module is only recompiled when it changes (see loadModule).
let gInstance = null;

// The analyses in progress between beginAnalyze() and finishAnalyze() or
// abortAnalyze(), keyed by the ID beginAnalyze() returned. Each holds the
// instance it runs against and its request and content buffers in that
// instance's linear memory. Several can be in progress at once while their
// data streams in.
const gPending = new Map();
let gNextAnalysisId = 1;

// Allocate len bytes in the module's linear memory, recording the allocation
// in aAllocations so it can be freed later. Returns 0 for a zero-length
// allocation, and throws if the module fails to allocate.
function allocIn(ex, aAllocations, len) {
  if (!len) {
    return 0;
  }
  // wasm32 pointers are unsigned, but i32 results reach JS as signed numbers.
  const ptr = ex.ca_alloc(len) >>> 0;
  if (!ptr) {
    throw new Error(`DLP wasm module failed to allocate ${len} bytes`);
  }
  aAllocations.push({ ptr, len });
  return ptr;
}

function freeAll(ex, aAllocations) {
  for (const a of aAllocations) {
    if (a.ptr) {
      ex.ca_free(a.ptr, a.len);
    }
  }
  aAllocations.length = 0;
}

// Compile and instantiate the module, verifying the ABI version. Called by the
// child actor whenever the configured module changes.
// eslint-disable-next-line no-unused-vars
function loadModule(moduleBytes) {
  const module = new WebAssembly.Module(moduleBytes);
  const instance = new WebAssembly.Instance(module, {});
  if (instance.exports.ca_abi_version() !== ABI_VERSION) {
    throw new Error("Unexpected DLP wasm ABI version");
  }
  gInstance = instance;
}

/**
 * Lower the caller-supplied rule objects into the module's FfiRule ABI in linear
 * memory. Allocates every buffer up front (linear-memory addresses stay valid as
 * memory grows), then writes them all with a single fresh view. Returns the
 * rules-array pointer/count.
 *
 * @param {*} ex  The module with ca_alloc entry point
 * @param {Array} aRules The rules to convert
 * @param {Array<{ptr: number, len: number}>} aAllocations Receives every
 *   allocation made, including those made before a failure, for the caller to
 *   free afterward.
 * @returns {{ptr: number, count: number}}
 */
function marshalRules(ex, aRules, aAllocations) {
  const alloc = len => allocIn(ex, aAllocations, len);

  const rules = aRules || [];
  if (!rules.length) {
    return { ptr: 0, count: 0 };
  }

  const encoder = new TextEncoder();
  const encodeAll = strs => Array.from(strs, s => encoder.encode(s));

  // Phase 1: encode strings and reserve all buffers. Linear-memory addresses
  // stay valid as memory grows, so we can write them all afterward.
  const prepared = rules.map(rule => {
    const nameBytes = encoder.encode(rule.name);
    const operations = Array.from(rule.operations);
    const domainBytes = encodeAll(rule.domains);
    const patternBytes = encodeAll(rule.contentPatterns);
    const messageBytes = rule.message ? encoder.encode(rule.message) : null;

    return {
      ruleType: rule.ruleType,
      nameBytes,
      namePtr: alloc(nameBytes.length),
      operations,
      operationsPtr: alloc(operations.length * 4),
      domainBytes,
      domainPtrs: domainBytes.map(b => alloc(b.length)),
      domainsArrPtr: alloc(domainBytes.length * FFI_STR_SIZE),
      patternBytes,
      patternPtrs: patternBytes.map(b => alloc(b.length)),
      patternsArrPtr: alloc(patternBytes.length * FFI_STR_SIZE),
      messageBytes,
      messagePtr: messageBytes ? alloc(messageBytes.length) : 0,
    };
  });
  const rulesPtr = alloc(prepared.length * FFI_RULE_SIZE);

  // Phase 2: write all bytes and structs with one view taken after allocation.
  const bytes = new Uint8Array(ex.memory.buffer);
  const view = new DataView(ex.memory.buffer);
  const writeStr = (offset, ptr, len) => {
    view.setUint32(offset, ptr, true);
    view.setUint32(offset + 4, len, true);
  };
  // Write each string's bytes and its FfiStr-array entry at `arrPtr`.
  const writeStrArray = (arrPtr, byteArrays, ptrs) => {
    byteArrays.forEach((byteArray, i) => {
      if (ptrs[i]) {
        bytes.set(byteArray, ptrs[i]);
      }
      writeStr(arrPtr + i * FFI_STR_SIZE, ptrs[i], byteArray.length);
    });
  };

  prepared.forEach((p, i) => {
    if (p.namePtr) {
      bytes.set(p.nameBytes, p.namePtr);
    }
    p.operations.forEach((op, j) => {
      view.setUint32(p.operationsPtr + j * 4, op, true);
    });
    writeStrArray(p.domainsArrPtr, p.domainBytes, p.domainPtrs);
    writeStrArray(p.patternsArrPtr, p.patternBytes, p.patternPtrs);
    if (p.messagePtr) {
      bytes.set(p.messageBytes, p.messagePtr);
    }

    const base = rulesPtr + i * FFI_RULE_SIZE;
    writeStr(base, p.namePtr, p.nameBytes.length);
    view.setUint32(base + FFI_RULE_OPERATIONS_OFFSET, p.operationsPtr, true);
    view.setUint32(
      base + FFI_RULE_OPERATIONS_COUNT_OFFSET,
      p.operations.length,
      true
    );
    view.setUint32(base + FFI_RULE_DOMAINS_OFFSET, p.domainsArrPtr, true);
    view.setUint32(
      base + FFI_RULE_DOMAINS_COUNT_OFFSET,
      p.domainBytes.length,
      true
    );
    view.setUint32(base + FFI_RULE_PATTERNS_OFFSET, p.patternsArrPtr, true);
    view.setUint32(
      base + FFI_RULE_PATTERNS_COUNT_OFFSET,
      p.patternBytes.length,
      true
    );
    view.setUint8(base + FFI_RULE_TYPE_OFFSET, p.ruleType);
    writeStr(
      base + FFI_RULE_MESSAGE_OFFSET,
      p.messagePtr,
      p.messageBytes ? p.messageBytes.length : 0
    );
  });

  return { ptr: rulesPtr, count: prepared.length };
}

// Start analyzing a request of aRequestLength bytes whose content is
// aContentLength bytes, allocating both buffers in the module's linear memory.
// Their bytes are then supplied with writeBytes(), and the analysis completed
// with finishAnalyze() or abandoned with abortAnalyze(). Returns the analysis's
// ID for those calls.
// eslint-disable-next-line no-unused-vars
function beginAnalyze(aRequestLength, aContentLength) {
  if (!gInstance) {
    throw new Error("DLP wasm module not loaded");
  }
  // Every buffer allocated for this analysis, freed by abortAnalyze() even if a
  // later step throws (e.g. the module traps during ca_analyze), so a failed
  // analysis can't leak the module's linear memory.
  const ex = gInstance.exports;
  const id = gNextAnalysisId++;
  const pending = {
    ex,
    allocations: [],
    buffers: {
      request: { ptr: 0, length: aRequestLength },
      content: { ptr: 0, length: aContentLength },
    },
  };
  gPending.set(id, pending);
  try {
    for (const buffer of Object.values(pending.buffers)) {
      buffer.ptr = allocIn(ex, pending.allocations, buffer.length);
    }
  } catch (e) {
    // The caller never gets the ID, so it can't abort the analysis itself.
    abortAnalyze(id);
    throw e;
  }
  return id;
}

// Copy a chunk into the "request" or "content" buffer (aBufferName) of
// analysis aId, at aOffset.
// eslint-disable-next-line no-unused-vars
function writeBytes(aId, aBufferName, aOffset, aChunk) {
  const pending = gPending.get(aId);
  if (!pending) {
    throw new Error("No such DLP wasm analysis is in progress");
  }
  const buffer = pending.buffers[aBufferName];
  if (aOffset < 0 || aOffset + aChunk.length > buffer.length) {
    throw new Error("DLP wasm analysis chunk is out of bounds");
  }
  // WebAssembly.Memory.buffer is detached and replaced when memory grows, so
  // the view is re-created for every chunk.
  new Uint8Array(pending.ex.memory.buffer).set(aChunk, buffer.ptr + aOffset);
}

// Run the module against analysis aId, whose buffers must have been filled
// with writeBytes(), then release its buffers. Returns the serialized
// ContentAnalysisResponse as a Uint8Array.
// eslint-disable-next-line no-unused-vars
function finishAnalyze(aId, { rules }) {
  const pending = gPending.get(aId);
  if (!pending) {
    throw new Error("No such DLP wasm analysis is in progress");
  }
  const { ex, allocations, buffers } = pending;
  let respPtr = 0;
  let outLen = 0;

  try {
    // WebAssembly.Memory.buffer is detached and replaced when memory grows, so
    // re-create the view from ex.memory.buffer after every call that allocates.
    const outLenPtr = allocIn(ex, allocations, 4);
    const marshalled = marshalRules(ex, rules, allocations);

    respPtr =
      ex.ca_analyze(
        buffers.request.ptr,
        buffers.request.length,
        buffers.content.ptr,
        buffers.content.length,
        marshalled.ptr,
        marshalled.count,
        outLenPtr
      ) >>> 0;
    outLen = new DataView(ex.memory.buffer).getUint32(outLenPtr, true);
    return new Uint8Array(ex.memory.buffer, respPtr, outLen).slice();
  } finally {
    if (respPtr) {
      ex.ca_free(respPtr, outLen);
    }
    abortAnalyze(aId);
  }
}

// Release the buffers of analysis aId, if it is still in progress.
// eslint-disable-next-line no-unused-vars
function abortAnalyze(aId) {
  const pending = gPending.get(aId);
  if (!pending) {
    return;
  }
  gPending.delete(aId);
  freeAll(pending.ex, pending.allocations);
}
