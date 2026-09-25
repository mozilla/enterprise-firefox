/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Bug 2072053: on Windows the launcher process announces on stdout the pid of
// the process that runs as the browser, and felt authenticates its IPC peer
// against that pid. The announcement is exactly one line of a fixed form;
// every other stdout line is browser output and must not be mistaken for one.

const { FeltProcessParent, parseAnnouncedBrowserPid } =
  ChromeUtils.importESModule("chrome://felt/content/FeltProcessParent.sys.mjs");

add_task(function test_announcement_yields_the_pid() {
  Assert.equal(parseAnnouncedBrowserPid("FELT_BROWSER_PID=4242"), 4242);
  // The launcher writes through a text-mode stream, so the drained line can
  // end in a carriage return or carry other surrounding whitespace.
  Assert.equal(parseAnnouncedBrowserPid("FELT_BROWSER_PID=4242\r"), 4242);
  Assert.equal(parseAnnouncedBrowserPid("  FELT_BROWSER_PID=1 "), 1);
  // A pid is a DWORD, so the full 32-bit range is accepted.
  Assert.equal(
    parseAnnouncedBrowserPid("FELT_BROWSER_PID=4294967295"),
    0xffffffff
  );
});

add_task(function test_other_lines_are_not_announcements() {
  const notAnnouncements = [
    "",
    "[Parent 4242, Main Thread] WARNING: browser log line",
    "FELT_BROWSER_PID=",
    "FELT_BROWSER_PID=0",
    "FELT_BROWSER_PID=-1",
    "FELT_BROWSER_PID=12abc",
    "FELT_BROWSER_PID=4294967296",
    "FELT_BROWSER_PID=4242 trailing text",
    "log: FELT_BROWSER_PID=4242",
    "felt_browser_pid=4242",
  ];
  for (const line of notAnnouncements) {
    Assert.strictEqual(
      parseAnnouncedBrowserPid(line),
      null,
      `not an announcement: ${JSON.stringify(line)}`
    );
  }
});

// The pipe hands back whatever each read returns, so the announcement can be
// split across reads or share one with other output. The drain must still pass
// it to its callback as one whole line.
add_task(async function test_drain_reassembles_a_split_announcement() {
  const encoder = new TextEncoder();
  const reads = [
    "browser output without a newline",
    "\nFELT_BROWSER_",
    "PID=42",
    "42\r\nmore output\n",
    "",
  ].map(s => encoder.encode(s));
  const pipe = {
    read: async () => reads.shift(),
    close: async () => {},
  };

  const lines = [];
  await FeltProcessParent.prototype.onPipeDataAvailable(pipe, 1, (pid, line) =>
    lines.push(line)
  );

  Assert.deepEqual(lines, [
    "browser output without a newline",
    "FELT_BROWSER_PID=4242\r",
    "more output",
  ]);
  Assert.deepEqual(
    lines.map(parseAnnouncedBrowserPid).filter(pid => pid !== null),
    [4242]
  );
});
