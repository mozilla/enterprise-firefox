/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};

ChromeUtils.defineLazyGetter(lazy, "Registrar", () =>
  Cc["@mozilla.org/win-background-task-registrar;1"].createInstance(
    Ci.nsIWinBackgroundTaskRegistrar
  )
);

/**
 * CLSID of the package's background task COM server, which on activation
 * launches `firefox.exe --backgroundtask <id>` for the task's registration name.
 * This is the single ComServer declared in the MSIX manifest.
 */
const BACKGROUND_TASK_COM_SERVER_CLSID = Components.ID(
  `{${AppConstants.MOZ_BACKGROUNDTASK_CLSID}}`
);

/**
 * Task generation and management for Windows MSIX (packaged) installs, using the
 * WinRT Windows.ApplicationModel.Background APIs via the Rust
 * nsIWinBackgroundTaskRegistrar component.
 *
 * Implements the API exposed in TaskScheduler.sys.mjs.
 *
 * Not intended for external use; this is in a separate module to ship the code
 * only on Windows, and to expose for testing.
 */
export const WinMSIXImpl = {
  registerTask(id, command, intervalSeconds, options) {
    const intervalMinutes = Math.floor(intervalSeconds / 60);
    const entryPointClsid =
      options?.entryPointClsid ?? BACKGROUND_TASK_COM_SERVER_CLSID;
    lazy.Registrar.registerTask(id, entryPointClsid, intervalMinutes);
  },

  deleteTask(id) {
    lazy.Registrar.deleteTask(id);
  },

  deleteAllTasks() {
    lazy.Registrar.deleteAllTasks();
  },

  taskExists(id) {
    return lazy.Registrar.taskExists(id);
  },
};
