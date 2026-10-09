/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

do_get_profile();

const { FELT_OPEN_WINDOW_DISPOSITION, gFeltPendingURLs } =
  ChromeUtils.importESModule("resource:///modules/FeltURLHandler.sys.mjs");

const RESTART_KEY_ENV = "MOZ_FELT_PENDING_URLS_KEY";
const PENDING_PATH = PathUtils.join(
  Services.dirsvc.get("ProfD", Ci.nsIFile).path,
  "pendingURLs.json"
);
const URL_A = {
  url: "https://example.com/a",
  disposition: FELT_OPEN_WINDOW_DISPOSITION.DEFAULT,
};
const URL_B = {
  url: "https://example.com/b",
  disposition: FELT_OPEN_WINDOW_DISPOSITION.NEW_WINDOW,
};

add_setup(async function () {
  await gFeltPendingURLs.init();
  registerCleanupFunction(() => {
    Services.env.set(RESTART_KEY_ENV, "");
  });
});

async function resetQueue() {
  gFeltPendingURLs.clear();
  gFeltPendingURLs._ready = false;
  gFeltPendingURLs._initPromise = null;
  gFeltPendingURLs._updateRestart = false;
  Services.env.set(RESTART_KEY_ENV, "");
  await IOUtils.remove(PENDING_PATH, { ignoreAbsent: true });
  await gFeltPendingURLs.init();
}

async function persistForUpdate() {
  gFeltPendingURLs.observe(null, "felt-update-restart");
  await gFeltPendingURLs.persistForRestart();
}

async function restore() {
  gFeltPendingURLs.clear();
  gFeltPendingURLs._ready = false;
  gFeltPendingURLs._updateRestart = false;
  await gFeltPendingURLs.init();
}

async function writeHandoff(urls, overrides = {}, path = PENDING_PATH) {
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: new TextEncoder().encode(path),
    },
    key,
    new TextEncoder().encode(
      JSON.stringify({ version: 1, createdAt: Date.now(), urls, ...overrides })
    )
  );
  const bytes = new Uint8Array(12 + ciphertext.byteLength);
  bytes.set(iv);
  bytes.set(new Uint8Array(ciphertext), 12);
  await IOUtils.write(PENDING_PATH, bytes);
  Services.env.set(
    RESTART_KEY_ENV,
    JSON.stringify(await crypto.subtle.exportKey("jwk", key))
  );
}

add_task(async function test_memory_queue_does_not_persist_on_other_restarts() {
  await resetQueue();
  gFeltPendingURLs.push(URL_A);
  await gFeltPendingURLs.persistForRestart();
  Assert.deepEqual([...gFeltPendingURLs], [URL_A]);
  Assert.ok(!(await IOUtils.exists(PENDING_PATH)));
  Assert.equal(Services.env.get(RESTART_KEY_ENV), "");
});

add_task(async function test_empty_queue_writes_no_file_or_key() {
  await resetQueue();
  await persistForUpdate();
  Assert.ok(!(await IOUtils.exists(PENDING_PATH)));
  Assert.equal(Services.env.get(RESTART_KEY_ENV), "");
});

add_task(async function test_update_restart_round_trip_and_consumption() {
  await resetQueue();
  gFeltPendingURLs.push(URL_A);
  gFeltPendingURLs.push(URL_B);
  await persistForUpdate();
  const bytes = await IOUtils.read(PENDING_PATH);
  Assert.ok(!new TextDecoder().decode(bytes).includes(URL_A.url));
  Assert.notEqual(Services.env.get(RESTART_KEY_ENV), "");

  await restore();
  Assert.deepEqual([...gFeltPendingURLs], [URL_A, URL_B]);
  Assert.equal(Services.env.get(RESTART_KEY_ENV), "", "key is consumed");
  Assert.ok(!(await IOUtils.exists(PENDING_PATH)), "file is consumed");
  await gFeltPendingURLs.init();
  Assert.equal(gFeltPendingURLs.length, 2, "init does not duplicate entries");

  await IOUtils.write(PENDING_PATH, bytes);
  await restore();
  Assert.equal(gFeltPendingURLs.length, 0, "a copied file cannot replay later");
});

add_task(async function test_restored_urls_precede_newer_urls() {
  await resetQueue();
  gFeltPendingURLs.push(URL_A);
  await persistForUpdate();
  gFeltPendingURLs.clear();
  gFeltPendingURLs._ready = false;
  gFeltPendingURLs.push(URL_B);
  await Promise.all([gFeltPendingURLs.init(), gFeltPendingURLs.init()]);
  Assert.deepEqual([...gFeltPendingURLs], [URL_A, URL_B]);
});

add_task(async function test_plaintext_file_is_discarded() {
  await resetQueue();
  await IOUtils.writeJSON(PENDING_PATH, { pendingURLs: [URL_A] });
  await restore();
  Assert.equal(gFeltPendingURLs.length, 0);
  Assert.ok(!(await IOUtils.exists(PENDING_PATH)));
});

add_task(async function test_tampered_ciphertext_is_rejected() {
  await resetQueue();
  gFeltPendingURLs.push(URL_A);
  await persistForUpdate();
  const bytes = await IOUtils.read(PENDING_PATH);
  bytes[bytes.length - 1] ^= 1;
  await IOUtils.write(PENDING_PATH, bytes);
  await restore();
  Assert.equal(gFeltPendingURLs.length, 0);
  Assert.equal(Services.env.get(RESTART_KEY_ENV), "");
  Assert.ok(!(await IOUtils.exists(PENDING_PATH)));
});

add_task(async function test_different_restart_uses_a_different_key() {
  await resetQueue();
  gFeltPendingURLs.push(URL_A);
  await persistForUpdate();
  const oldBytes = await IOUtils.read(PENDING_PATH);
  const oldKey = Services.env.get(RESTART_KEY_ENV);
  await restore();
  await persistForUpdate();
  Assert.notEqual(Services.env.get(RESTART_KEY_ENV), oldKey);
  await IOUtils.write(PENDING_PATH, oldBytes);
  await restore();
  Assert.equal(gFeltPendingURLs.length, 0);
});

add_task(async function test_restored_chrome_urls_are_rejected() {
  await resetQueue();
  await writeHandoff([
    { url: "chrome://browser/content/browser.xhtml", disposition: 0 },
    URL_A,
  ]);
  await restore();
  Assert.deepEqual([...gFeltPendingURLs], [URL_A]);
});

add_task(async function test_handoff_is_bound_to_the_profile() {
  await resetQueue();
  await writeHandoff([URL_A], {}, `${PENDING_PATH}.another-profile`);
  await restore();
  Assert.equal(gFeltPendingURLs.length, 0);
});

add_task(async function test_expired_future_and_invalid_handoffs() {
  for (const overrides of [
    { createdAt: Date.now() - 31 * 60 * 1000 },
    { createdAt: Date.now() + 60 * 1000 },
    { createdAt: null },
    { version: 2 },
    { urls: {} },
  ]) {
    await resetQueue();
    await writeHandoff([URL_A], overrides);
    await restore();
    Assert.equal(gFeltPendingURLs.length, 0, JSON.stringify(overrides));
    Assert.equal(Services.env.get(RESTART_KEY_ENV), "");
  }
});

add_task(async function test_missing_file_consumes_key_and_accepts_new_urls() {
  await resetQueue();
  await writeHandoff([URL_A]);
  await IOUtils.remove(PENDING_PATH);
  await restore();
  gFeltPendingURLs.push(URL_B);
  Assert.deepEqual([...gFeltPendingURLs], [URL_B]);
  Assert.equal(Services.env.get(RESTART_KEY_ENV), "");
});

add_task(async function test_failed_write_does_not_export_key() {
  await resetQueue();
  gFeltPendingURLs.push(URL_A);
  await IOUtils.makeDirectory(PENDING_PATH);
  try {
    await persistForUpdate();
    Assert.equal(Services.env.get(RESTART_KEY_ENV), "");
    Assert.equal((await IOUtils.stat(PENDING_PATH)).type, "directory");
  } finally {
    await IOUtils.remove(PENDING_PATH);
  }
});

add_task(async function test_oversized_handoff_is_rejected() {
  await resetQueue();
  gFeltPendingURLs.push({
    url: `https://example.com/${"a".repeat(1024 * 1024)}`,
  });
  await persistForUpdate();
  Assert.ok(!(await IOUtils.exists(PENDING_PATH)));
  Assert.equal(Services.env.get(RESTART_KEY_ENV), "");
});
