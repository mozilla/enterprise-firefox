/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { ctypes } = ChromeUtils.importESModule(
  "resource://gre/modules/ctypes.sys.mjs"
);

// Not exposed by ChromeUtils.getLibcConstants(); the value is the same on
// Linux and macOS.
const F_GETFD = 1;

const TEST_SCRIPT = do_get_file("data_test_script.py").path;

add_task(async function test_subprocess_fd_inherit() {
  const { libc } = ChromeUtils.importESModule(
    "resource://gre/modules/subprocess/subprocess_unix.sys.mjs"
  );
  const { F_SETFD } = ChromeUtils.getLibcConstants();

  const fds = ctypes.int.array(2)();
  equal(libc.pipe(fds), 0, "Created a pipe");
  const [r, w] = [fds[0], fds[1]];
  equal(
    libc.fcntl(w, F_SETFD, ctypes.int(0)),
    0,
    "Cleared FD_CLOEXEC on the write end"
  );

  const proc = await Subprocess.call({
    command: await Subprocess.pathSearch(Services.env.get("PYTHON")),
    arguments: ["-u", TEST_SCRIPT, "write_fd", String(w)],
    fdInherit: [w],
  });
  equal(
    libc.fcntl(w, F_GETFD),
    -1,
    "The parent's copy of the inherited fd is closed after launch"
  );

  equal((await proc.wait()).exitCode, 0, "The subprocess exits cleanly");

  const buffer = new ArrayBuffer(16);
  const count = +libc.read(r, buffer, buffer.byteLength);
  equal(
    new TextDecoder().decode(new Uint8Array(buffer, 0, Math.max(count, 0))),
    "ok",
    "The child wrote to the inherited fd"
  );
  equal(
    +libc.read(r, buffer, buffer.byteLength),
    0,
    "The read end sees EOF once the child has exited"
  );
  libc.close(r);
});
