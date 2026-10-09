/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Bug 2073022: the browser only trusts the IPC endpoint named on its command
// line if the process at the other end is the felt process that spawned it, so
// felt names its own process id next to the endpoint name.

const { browserIpcArgs } = ChromeUtils.importESModule(
  "chrome://felt/content/FeltProcessParent.sys.mjs"
);

add_task(function test_command_line_names_the_endpoint_and_felt_pid() {
  Assert.greater(Services.appinfo.processID, 0, "felt has a usable pid");
  Assert.deepEqual(browserIpcArgs("endpoint-name"), [
    "-felt",
    "endpoint-name",
    "-feltPid",
    String(Services.appinfo.processID),
  ]);
});
