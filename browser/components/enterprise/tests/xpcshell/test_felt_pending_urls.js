/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Tests the stored copy of the external URL queue. It mirrors the queue so an
// app restart can carry it over, and only a launch that is itself a restart
// reads it back.

// Imported lazily so FeltStorage doesn't resolve its "UAppData"-based path
// before makeFakeAppDir() runs below.
const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  FeltStorage: "moz-src:///toolkit/components/felt/FeltStorage.sys.mjs",
  FELT_OPEN_WINDOW_DISPOSITION:
    "moz-src:///browser/components/FeltURLHandler.sys.mjs",
  gFeltPendingURLs: "moz-src:///browser/components/FeltURLHandler.sys.mjs",
});

const { makeFakeAppDir } = ChromeUtils.importESModule(
  "resource://testing-common/AppData.sys.mjs"
);
const { OSKeyStore } = ChromeUtils.importESModule(
  "resource://gre/modules/OSKeyStore.sys.mjs"
);
const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);

async function fakeEncrypt(plaintext) {
  return `enc(${plaintext})`;
}

// OSKeyStore.decrypt hands back a binary string, so the fake mirrors that.
async function fakeDecrypt(ciphertext) {
  return unescape(
    encodeURIComponent(ciphertext.replace(/^enc\((.*)\)$/s, "$1"))
  );
}

/**
 * Holds the next encrypt until it is released.
 *
 * @returns {{started: Promise<void>, release: Function}} started resolves once
 *   the encrypt has been called; release lets it finish.
 */
function holdEncrypt() {
  let release, markStarted;
  const gate = new Promise(resolve => (release = resolve));
  const started = new Promise(resolve => (markStarted = resolve));
  OSKeyStore.encrypt.callsFake(async plaintext => {
    markStarted();
    await gate;
    return fakeEncrypt(plaintext);
  });
  return {
    started,
    release() {
      release();
      OSKeyStore.encrypt.callsFake(fakeEncrypt);
    },
  };
}

function url(spec, disposition) {
  return {
    url: spec,
    disposition: disposition ?? lazy.FELT_OPEN_WINDOW_DISPOSITION.DEFAULT,
  };
}

/** The raw value FeltStorage holds, bypassing the public accessors. */
function storedQueue() {
  return lazy.FeltStorage._feltStorage.data.pendingURLs;
}

function plantStoredQueue(value) {
  lazy.FeltStorage._feltStorage.data.pendingURLs = value;
}

/**
 * A stored record as storePendingURLs() would write it, with any field
 * overridable.
 *
 * @param {object} [fields]
 * @param {Array<object>} [fields.urls] Encrypted into the ciphertext.
 * @returns {object}
 */
function record({
  urls = [url("https://example.com/planted")],
  ...fields
} = {}) {
  return {
    version: 1,
    ciphertext: `enc(${JSON.stringify(urls)})`,
    ...fields,
  };
}

/** The URLs inside the stored value, as the fake keystore would decrypt it. */
function storedURLs() {
  return JSON.parse(
    storedQueue().ciphertext.replace(/^enc\((.*)\)$/s, "$1")
  ).map(entry => entry.url);
}

async function queuePendingURLs(...payloads) {
  for (const payload of payloads) {
    lazy.gFeltPendingURLs.push(payload);
  }
  await lazy.gFeltPendingURLs._writes;
}

/**
 * Resets the queue to how the next launch finds it and starts its restore.
 *
 * @param {object} options
 * @param {boolean} options.restarted Whether it follows an in-app restart.
 * @returns {Promise<void>} Resolves once the restore has finished.
 */
function beginLaunch({ restarted }) {
  lazy.gFeltPendingURLs._pendingURLs = [];
  lazy.gFeltPendingURLs._ready = false;
  lazy.gFeltPendingURLs._initPromise = null;
  Services.env.set("MOZ_APP_RESTART", restarted ? "1" : "");
  const restoring = lazy.gFeltPendingURLs.init();
  // The restore reads it before its first await.
  Services.env.set("MOZ_APP_RESTART", "");
  return restoring;
}

/**
 * Stands in for the next launch.
 *
 * @param {object} options
 * @param {boolean} options.restarted Whether it follows an in-app restart.
 * @returns {Promise<Array<object>>} The queue that launch starts with.
 */
async function relaunch({ restarted }) {
  await beginLaunch({ restarted });
  await lazy.gFeltPendingURLs._writes;
  return [...lazy.gFeltPendingURLs];
}

add_setup(async function () {
  do_get_profile();
  await makeFakeAppDir();
  await lazy.FeltStorage.init();

  // The queue is only mirrored to disk in the Felt UI process.
  const felt = Services.felt;
  Object.defineProperty(Services, "felt", {
    configurable: true,
    value: { isFeltUI: () => true },
  });

  // Reversible stand-ins so the tests can assert both that the queue is
  // encrypted on the way in and recovered on the way out, without a real
  // keystore.
  sinon.stub(OSKeyStore, "encrypt").callsFake(fakeEncrypt);
  sinon.stub(OSKeyStore, "decrypt").callsFake(fakeDecrypt);

  registerCleanupFunction(() => {
    sinon.restore();
    Object.defineProperty(Services, "felt", {
      configurable: true,
      value: felt,
    });
  });
});

add_task(async function test_nothing_stored_restores_nothing() {
  Assert.deepEqual(
    await relaunch({ restarted: true }),
    [],
    "a restart with nothing stored starts empty"
  );
});

add_task(async function test_queue_is_stored_encrypted() {
  await relaunch({ restarted: false });
  OSKeyStore.encrypt.resetHistory();
  await queuePendingURLs(url("https://example.com/a"));

  Assert.ok(OSKeyStore.encrypt.calledOnce, "the queue is encrypted once");
  const [plaintext] = OSKeyStore.encrypt.firstCall.args;
  Assert.deepEqual(
    JSON.parse(plaintext),
    [url("https://example.com/a")],
    "the keystore is handed the queued URLs"
  );
  const stored = storedQueue();
  Assert.strictEqual(
    stored.ciphertext,
    await OSKeyStore.encrypt.firstCall.returnValue,
    "the stored ciphertext is exactly what the keystore returned"
  );
  Assert.deepEqual(
    Object.keys(stored).sort(),
    ["ciphertext", "version"],
    "nothing but the ciphertext and its metadata is stored"
  );
  Assert.equal(stored.version, 1, "the version is stored in the clear");
});

add_task(async function test_restarts_keep_carrying_the_queue_over() {
  await relaunch({ restarted: false });
  const queued = [
    url("https://example.com/a"),
    url("https://example.com/b", lazy.FELT_OPEN_WINDOW_DISPOSITION.NEW_WINDOW),
  ];
  await queuePendingURLs(...queued);

  // A URL that arrives while FELT is still signed out can sit behind several
  // update restarts in a row before anything opens it.
  for (let restart = 1; restart <= 5; restart++) {
    Assert.deepEqual(
      await relaunch({ restarted: true }),
      queued,
      `restart ${restart} carries the queue over in the order it was queued`
    );
    Assert.deepEqual(
      storedURLs(),
      queued.map(entry => entry.url),
      `and stores it again for the restart after ${restart}`
    );
  }

  const late = url("https://example.com/c");
  await queuePendingURLs(late);
  queued.push(late);
  for (let restart = 1; restart <= 2; restart++) {
    Assert.deepEqual(
      await relaunch({ restarted: true }),
      queued,
      `a URL queued between restarts is carried by restart ${restart} after it`
    );
  }
});

add_task(async function test_cold_start_discards_the_queue() {
  await relaunch({ restarted: false });
  await queuePendingURLs(url("https://example.com/cold-start"));

  Assert.deepEqual(
    await relaunch({ restarted: false }),
    [],
    "a launch that is not a restart does not reopen queued URLs"
  );
  Assert.equal(
    storedQueue(),
    undefined,
    "and the stored copy is dropped rather than left for a later restart"
  );
});

add_task(async function test_restart_requested_during_cold_start_restore() {
  await relaunch({ restarted: false });
  await queuePendingURLs(url("https://example.com/leftover"));

  const restoring = beginLaunch({ restarted: false });
  // Quit() sets this in the current process when it requests a restart.
  Services.env.set("MOZ_APP_RESTART", "1");
  registerCleanupFunction(() => Services.env.set("MOZ_APP_RESTART", ""));
  await restoring;
  await lazy.gFeltPendingURLs._writes;

  Assert.deepEqual(
    [...lazy.gFeltPendingURLs],
    [],
    "a cold launch still discards the queue if a restart is requested mid-restore"
  );
  Assert.equal(storedQueue(), undefined, "and the stored copy is dropped");
});

add_task(async function test_draining_the_queue_clears_the_stored_copy() {
  await relaunch({ restarted: false });
  await queuePendingURLs(url("https://example.com/drained"));

  lazy.gFeltPendingURLs.clear();
  await lazy.gFeltPendingURLs._writes;

  Assert.equal(
    storedQueue(),
    undefined,
    "URLs that have been forwarded are no longer stored"
  );
  Assert.deepEqual(
    await relaunch({ restarted: true }),
    [],
    "so a restart has nothing to reopen"
  );
});

add_task(async function test_restored_urls_precede_newly_queued_ones() {
  await relaunch({ restarted: false });
  await queuePendingURLs(url("https://example.com/before-restart"));

  OSKeyStore.decrypt.callsFake(async ciphertext => {
    // Arrives on the command line while the restore is still reading the
    // stored queue, as it would on a launch handed a URL straight away.
    lazy.gFeltPendingURLs.push(url("https://example.com/after-restart"));
    return fakeDecrypt(ciphertext);
  });
  const restored = await relaunch({ restarted: true });
  OSKeyStore.decrypt.callsFake(fakeDecrypt);

  Assert.deepEqual(
    restored.map(entry => entry.url),
    ["https://example.com/before-restart", "https://example.com/after-restart"],
    "the restored URL is opened ahead of the one that arrived after it"
  );
  Assert.deepEqual(
    storedURLs(),
    ["https://example.com/before-restart", "https://example.com/after-restart"],
    "the early push waited for the restore instead of overwriting the stored queue"
  );
});

add_task(async function test_legacy_plaintext_file_is_removed_unread() {
  const legacyFile = PathUtils.join(PathUtils.profileDir, "pendingURLs.json");
  await relaunch({ restarted: false });
  await IOUtils.writeJSON(legacyFile, {
    pendingURLs: [url("https://example.com/legacy")],
  });

  Assert.deepEqual(
    await relaunch({ restarted: true }),
    [],
    "URLs from the plaintext file an older build left behind are not restored"
  );
  Assert.ok(
    !(await IOUtils.exists(legacyFile)),
    "and the file is removed from the scratch profile"
  );
});

add_task(async function test_reading_leaves_the_stored_queue_in_place() {
  await relaunch({ restarted: false });
  await queuePendingURLs(url("https://example.com/mid-restore"));

  Assert.deepEqual(
    (await lazy.FeltStorage.readPendingURLs()).map(entry => entry.url),
    ["https://example.com/mid-restore"],
    "the stored queue is read back"
  );
  Assert.deepEqual(
    storedURLs(),
    ["https://example.com/mid-restore"],
    "and left on disk, so a restart that interrupts the restore still finds it"
  );
});

add_task(async function test_signout_during_restore_discards_restored_urls() {
  await relaunch({ restarted: false });
  await queuePendingURLs(url("https://example.com/previous-session"));

  OSKeyStore.decrypt.callsFake(async ciphertext => {
    // A signout while a slow keystore is still decrypting the stored queue.
    lazy.gFeltPendingURLs.clear();
    return fakeDecrypt(ciphertext);
  });
  const restored = await relaunch({ restarted: true });
  OSKeyStore.decrypt.callsFake(fakeDecrypt);

  Assert.deepEqual(
    restored,
    [],
    "URLs from the session that was signed out are not restored into the queue"
  );
  Assert.equal(storedQueue(), undefined, "and they are not stored again");
});

add_task(async function test_unknown_version_is_left_for_its_build() {
  await relaunch({ restarted: false });
  const other = record({ version: 2, urls: [url("https://example.com/v2")] });
  plantStoredQueue(other);
  OSKeyStore.decrypt.resetHistory();

  Assert.deepEqual(
    await relaunch({ restarted: true }),
    [],
    "a record from another version is not restored"
  );
  Assert.deepEqual(
    storedQueue(),
    other,
    "and it is left in place for the build that wrote it"
  );
  Assert.ok(OSKeyStore.decrypt.notCalled, "without being decrypted");
});

add_task(async function test_unreadable_stored_queue_is_discarded() {
  await relaunch({ restarted: false });
  const unreadable = record({ ciphertext: "not from the keystore" });
  OSKeyStore.decrypt
    .withArgs(unreadable.ciphertext)
    .rejects(new Error("Invalid ciphertext"));
  plantStoredQueue(unreadable);

  Assert.deepEqual(
    await relaunch({ restarted: true }),
    [],
    "a value the keystore did not write is dropped"
  );
  Assert.equal(
    storedQueue(),
    undefined,
    "and it is consumed rather than retried on every launch"
  );
});

add_task(async function test_malformed_stored_records_are_discarded() {
  const malformed = [
    ["a bare string", "enc([])"],
    ["a number", 42],
    ["null", null],
    ["an array", [record()]],
    ["an empty object", {}],
    ["a record with no version", record({ version: undefined })],
    ["a string version", record({ version: "1" })],
    ["a fractional version", record({ version: 1.5 })],
    ["a missing ciphertext", record({ ciphertext: undefined })],
    ["a non-string ciphertext", record({ ciphertext: 42 })],
    ["ciphertext that is not JSON", record({ ciphertext: "enc({not json" })],
    [
      "ciphertext holding an object",
      record({ ciphertext: 'enc({"urls":[]})' }),
    ],
    ["ciphertext holding a string", record({ ciphertext: 'enc("https://a")' })],
    ["ciphertext holding null", record({ ciphertext: "enc(null)" })],
    ["an empty list of URLs", record({ urls: [] })],
    [
      "entries that are not objects",
      record({ urls: [null, 42, "https://example.com/bare", [], true] }),
    ],
    [
      "entries with a non-string url",
      record({ urls: [{ url: 42 }, { url: {} }, { url: null }] }),
    ],
  ];

  for (const [description, value] of malformed) {
    await relaunch({ restarted: false });
    plantStoredQueue(value);

    Assert.deepEqual(
      await relaunch({ restarted: true }),
      [],
      `${description} restores nothing`
    );
    Assert.equal(storedQueue(), undefined, `and ${description} is consumed`);
  }
});

add_task(async function test_restored_urls_are_sanitized() {
  await relaunch({ restarted: false });
  plantStoredQueue(
    record({
      urls: [
        url("chrome://browser/content/browser.xhtml"),
        url("https://example.com/kept"),
        url("not a url at all"),
      ],
    })
  );

  Assert.deepEqual(
    (await relaunch({ restarted: true })).map(entry => entry.url),
    ["https://example.com/kept"],
    "chrome: and unparseable URLs do not survive being restored"
  );
  Assert.deepEqual(
    storedURLs(),
    ["https://example.com/kept"],
    "and the stored copy is rewritten without them"
  );

  plantStoredQueue(
    record({ urls: [url("chrome://browser/content/browser.xhtml")] })
  );
  Assert.deepEqual(
    await relaunch({ restarted: true }),
    [],
    "a queue that sanitizing empties restores nothing"
  );
  Assert.equal(storedQueue(), undefined, "and its stored copy is removed");
});

add_task(async function test_signout_drops_the_stored_queue() {
  await relaunch({ restarted: false });
  await queuePendingURLs(url("https://example.com/signed-out"));

  lazy.gFeltPendingURLs.clear();
  await lazy.FeltStorage.endSession();
  await lazy.gFeltPendingURLs._writes;

  Assert.equal(
    storedQueue(),
    undefined,
    "signing out removes the stored queue"
  );
  Assert.deepEqual(
    await relaunch({ restarted: true }),
    [],
    "URLs queued by the session that ended are not reopened"
  );
});

add_task(async function test_signout_behind_a_stalled_write_drops_the_queue() {
  await relaunch({ restarted: false });
  await queuePendingURLs(url("https://example.com/previous-session"));

  // A later write whose encrypt never settles until the very end.
  const { started, release } = holdEncrypt();
  lazy.gFeltPendingURLs.push(url("https://example.com/stalled"));
  await started;

  lazy.gFeltPendingURLs.clear();
  await lazy.FeltStorage.endSession();

  Assert.equal(
    storedQueue(),
    undefined,
    "signout removes the stored queue without waiting for the stalled write"
  );

  release();
  await lazy.gFeltPendingURLs._writes;

  Assert.equal(
    storedQueue(),
    undefined,
    "the stalled write finishing afterwards does not bring the queue back"
  );
  Assert.deepEqual(
    await relaunch({ restarted: true }),
    [],
    "so a restart has nothing from the previous session to reopen"
  );
});

add_task(
  async function test_signout_then_new_url_does_not_store_the_old_queue() {
    await relaunch({ restarted: false });

    let storedWhenNextWriteBegan;
    let calls = 0;
    OSKeyStore.encrypt.callsFake(async plaintext => {
      if (calls++ === 0) {
        // A signout, then a new link, while the first write is still encrypting.
        lazy.gFeltPendingURLs.clear();
        await lazy.FeltStorage.endSession();
        lazy.gFeltPendingURLs.push(url("https://example.com/next-session"));
      } else {
        storedWhenNextWriteBegan = storedQueue();
      }
      return fakeEncrypt(plaintext);
    });

    lazy.gFeltPendingURLs.push(url("https://example.com/previous-session"));
    await lazy.gFeltPendingURLs._writes;
    // The signout queued another write while the first one was encrypting.
    await lazy.gFeltPendingURLs._writes;
    OSKeyStore.encrypt.callsFake(fakeEncrypt);

    Assert.equal(
      storedWhenNextWriteBegan,
      undefined,
      "the write from before signout is dropped rather than stored"
    );
    Assert.deepEqual(
      storedURLs(),
      ["https://example.com/next-session"],
      "only the URL queued after signout is stored"
    );
  }
);

add_task(async function test_ending_a_session_keeps_the_stored_queue() {
  await relaunch({ restarted: false });
  await queuePendingURLs(url("https://example.com/failed-unlock"));

  // A failed unlock rolls back the session it began without signing out.
  await lazy.FeltStorage.endSession();

  Assert.deepEqual(
    (await relaunch({ restarted: true })).map(entry => entry.url),
    ["https://example.com/failed-unlock"],
    "a restart after a failed unlock still carries the queue over"
  );
});

add_task(async function test_a_burst_of_pushes_is_written_once() {
  await relaunch({ restarted: false });
  OSKeyStore.encrypt.resetHistory();

  await queuePendingURLs(
    url("https://example.com/1"),
    url("https://example.com/2"),
    url("https://example.com/3")
  );

  Assert.equal(
    OSKeyStore.encrypt.callCount,
    1,
    "pushes made before the write starts share a single write"
  );
  Assert.deepEqual(
    storedURLs(),
    ["https://example.com/1", "https://example.com/2", "https://example.com/3"],
    "and that write holds all of them"
  );
});

add_task(async function test_queue_throws_outside_the_felt_ui_process() {
  const felt = Services.felt;
  Object.defineProperty(Services, "felt", {
    configurable: true,
    value: { isFeltUI: () => false },
  });
  registerCleanupFunction(() =>
    Object.defineProperty(Services, "felt", { configurable: true, value: felt })
  );

  const outsideFeltUI = /only used in the Felt UI process/;
  lazy.gFeltPendingURLs._ready = false;
  await Assert.rejects(
    lazy.gFeltPendingURLs.init(),
    outsideFeltUI,
    "init() rejects outside the Felt UI process"
  );
  Assert.throws(
    () => lazy.gFeltPendingURLs.push(url("https://example.com/browser")),
    outsideFeltUI,
    "push() throws outside the Felt UI process"
  );
  Assert.throws(
    () => lazy.gFeltPendingURLs.clear(),
    outsideFeltUI,
    "clear() throws outside the Felt UI process"
  );
});
