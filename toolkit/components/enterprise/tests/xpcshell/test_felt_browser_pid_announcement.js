/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Bug 2072053: on Windows the launcher process announces on stderr the pid of
// the process that runs as the browser, and felt authenticates its IPC peer
// against that pid. The announcement is exactly one line of a fixed form;
// every other stderr line is browser output and must not be mistaken for one.

const { parseAnnouncedBrowserPid } = ChromeUtils.importESModule(
  "chrome://felt/content/FeltProcessParent.sys.mjs"
);

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
