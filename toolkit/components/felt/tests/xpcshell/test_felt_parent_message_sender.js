/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// FeltParent:* messages are sent by parent-process code through the
// Services.cpmm loopback. Felt must ignore the same messages when a content
// process sends them.

const { Felt } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/felt/Felt.sys.mjs"
);
const { XPCShellContentUtils } = ChromeUtils.importESModule(
  "resource://testing-common/XPCShellContentUtils.sys.mjs"
);
const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);

XPCShellContentUtils.init(this);

const MESSAGE = "FeltParent:ForceFeltFocus";

let gFelt;

add_setup(function () {
  gFelt = new Felt();
  gFelt._win = { focus: sinon.spy() };
  gFelt.addFeltMessageListeners();
  registerCleanupFunction(() => gFelt.removeFeltMessageListeners());
});

// Resolves once ppmm has dispatched the next MESSAGE, by which point the
// Felt listener registered before this one has already handled it.
function waitForDispatch() {
  return new Promise(resolve => {
    let listener = {
      receiveMessage(message) {
        Services.ppmm.removeMessageListener(MESSAGE, listener);
        resolve(message.target.isInProcess);
      },
    };
    Services.ppmm.addMessageListener(MESSAGE, listener);
  });
}

add_task(async function test_content_process_message_ignored() {
  gFelt._win.focus.resetHistory();
  let page = await XPCShellContentUtils.loadContentPage("about:blank", {
    remote: true,
  });

  let dispatched = waitForDispatch();
  await page.spawn([MESSAGE], name => {
    Services.cpmm.sendAsyncMessage(name, {});
  });
  ok(!(await dispatched), "Message came from a content process");
  ok(gFelt._win.focus.notCalled, "Felt ignored the content process message");

  await page.close();
});

add_task(async function test_parent_process_message_handled() {
  gFelt._win.focus.resetHistory();

  let dispatched = waitForDispatch();
  Services.cpmm.sendAsyncMessage(MESSAGE, {});
  ok(await dispatched, "Message came through the in-process loopback");
  ok(gFelt._win.focus.calledOnce, "Felt handled the parent process message");
});
