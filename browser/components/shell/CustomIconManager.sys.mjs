/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const PREF_ICON_ID = "browser.shell.customIcon.id";

// Inlined catalog of selectable icons. Each entry has:
//
//   iconResourceId: the Win32 resource ID of an icon embedded in firefox.exe
//     at build time (declared in toolkit/xre/nsNativeAppSupportWin.h and
//     browser/app/splash.rc). This is what gets applied: shortcuts reference
//     it as firefox.exe,-<iconResourceId> and live windows load it directly.
//     The catalog-id -> resource-id mapping is ABI: never remap or reuse an id
//     once it has shipped, even if the icon is retired from the picker.
//   preview: a chrome:// URI resolving to the same .ico shipped in omni.ja
//     (see browser/components/shell/jar.mn). Used only to render a thumbnail in
//     the about:settings picker; never used to apply the icon. PE resources are
//     not addressable by a URL, hence the separate display asset.
const CATALOG = {
  retro: {
    iconResourceId: 1100, // IDI_CUSTOM_RETRO
    preview: "chrome://browser/content/icons/retro.ico",
  },
};

const lazy = {};

XPCOMUtils.defineLazyServiceGetters(lazy, {
  ShellService: [
    "@mozilla.org/browser/shell-service;1",
    Ci.nsIWindowsShellService,
  ],
  WinTaskbar: ["@mozilla.org/windows-taskbar;1", Ci.nsIWinTaskbar],
});

ChromeUtils.defineLazyGetter(lazy, "logConsole", function () {
  return console.createInstance({
    prefix: "CustomIconManager",
    maxLogLevel: Services.prefs.getBoolPref(
      "browser.shell.customIcon.log",
      false
    )
      ? "Debug"
      : "Warn",
  });
});

/**
 * Absolute path to the currently running browser executable. Custom icons are
 * embedded as resources in this executable, so it is both the icon source for
 * applying a custom icon and (with index 0) the default-icon source when
 * reverting Windows shortcuts.
 *
 * @returns {string}
 */
function browserExePath() {
  return Services.dirsvc.get("XREExeF", Ci.nsIFile).path;
}

/**
 * Apply the given executable icon to every Windows .lnk file that this install
 * owns (taskbar pin, per-user Desktop, per-user Start Menu).
 *
 * Per-shortcut failures are logged but do not abort the rest of the
 * iteration; partial success is permitted.
 *
 * @param {string} iconPath Absolute path to the icon source (the executable).
 * @param {number} iconResourceId Resource ID of the icon within iconPath (e.g.
 *        1100 for IDI_CUSTOM_RETRO), or 0 for the executable's default icon.
 *        setShortcutsIcon owns the Win32 encoding of this reference.
 * @returns {Promise<boolean>} True if at least one shortcut was updated.
 */
async function applyIconToWindowsShortcuts(iconPath, iconResourceId) {
  let aumid = lazy.WinTaskbar.defaultGroupId;
  let shortcuts = [];
  try {
    shortcuts = await lazy.ShellService.enumerateInstallShortcuts(aumid);
  } catch (ex) {
    lazy.logConsole.error("enumerateInstallShortcuts failed", ex);
    return false;
  }

  lazy.logConsole.debug(
    `enumerateInstallShortcuts(${aumid}) matched ${shortcuts.length} ` +
      `shortcut(s): ${shortcuts.join(", ")}`
  );
  if (!shortcuts.length) {
    lazy.logConsole.warn(
      `No shortcuts matched this install (AUMID ${aumid}); nothing to update. ` +
        `Only shortcuts created by Firefox carry this AUMID - hand-made ` +
        `Explorer shortcuts are not modified.`
    );
    return false;
  }

  try {
    await lazy.ShellService.setShortcutsIcon(
      shortcuts,
      iconPath,
      iconResourceId
    );
  } catch (ex) {
    if (ex.result == Cr.NS_ERROR_NOT_AVAILABLE) {
      lazy.logConsole.error("Could not update any shortcut icons.");
      return false;
    }
    lazy.logConsole.error(
      "Fatal error while attempting to update short icons:",
      ex
    );
    return false;
  }

  lazy.logConsole.debug(
    `Set icon resource ${iconResourceId} from "${iconPath}" on ` +
      `${shortcuts.length} shortcut(s).`
  );
  return true;
}

/**
 * Push the runtime icon override to every top-level Windows window in this
 * process (excepting private browsing windows and web application windows).
 * A resource ID of 0 reverts windows to the default executable icon.
 *
 * @param {number} iconResourceId Win32 resource ID of an icon embedded in the
 *        executable, or 0 to clear.
 */
function applyRuntimeWindowsIcon(iconResourceId) {
  try {
    lazy.WinTaskbar.setAllWindowIcons(iconResourceId);
  } catch (ex) {
    lazy.logConsole.error("setAllWindowIcons failed", ex);
  }
}

export const CustomIconManager = {
  /**
   * Return the catalog of selectable icons. Currently returns an inlined
   * mapping of id -> { iconResourceId, preview }. Future versions may grow this
   * to include user-supplied entries.
   *
   * @returns {object} The catalog object. Callers must treat it as read-only.
   */
  list() {
    return CATALOG;
  },

  /**
   * Make the icon identified by `id` the active custom icon for this
   * install. On Windows this:
   *
   *   1. Updates every per-user .lnk this install owns to reference the
   *      embedded icon resource (firefox.exe,-<resource-id>).
   *   2. Records the choice in a pref.
   *   3. Pushes the icon to live windows via WM_SETICON.
   *
   * @param {string} id A key in the catalog returned by list().
   * @returns {Promise<void>}
   * @throws {Error} If `id` is not in the catalog, the platform is not Windows,
   *         or this is an MSIX (packaged) build, where the feature is
   *         unsupported.
   */
  async apply(id) {
    if (AppConstants.platform !== "win") {
      throw new Error("Custom icon is only supported on Windows.");
    }

    if (Services.sysinfo.getProperty("hasWinPackageId")) {
      throw new Error(
        "Custom launcher icons are not supported on MSIX (packaged) builds."
      );
    }

    let entry = CATALOG[id];
    if (!entry) {
      throw new Error(`Unknown icon id: ${id}`);
    }

    let updated = await applyIconToWindowsShortcuts(
      browserExePath(),
      entry.iconResourceId
    );
    if (!updated) {
      lazy.logConsole.warn(
        `apply("${id}"): no Windows shortcuts were updated. The running ` +
          `window icon will change, but desktop/Start Menu/taskbar shortcuts ` +
          `will not. See the log above for why.`
      );
    }

    Services.prefs.setStringPref(PREF_ICON_ID, id);
    applyRuntimeWindowsIcon(entry.iconResourceId);
  },

  /**
   * Revert all per-user shortcuts and the runtime icon for this process back
   * to the default browser icon, and clear the pref.
   *
   * Safe to call when no custom icon is currently active.
   *
   * @returns {Promise<void>}
   */
  async revert() {
    if (AppConstants.platform !== "win") {
      return;
    }

    await applyIconToWindowsShortcuts(browserExePath(), 0);

    Services.prefs.clearUserPref(PREF_ICON_ID);
    applyRuntimeWindowsIcon(0);
  },

  /**
   * Eagerly register the runtime icon override before any browser windows
   * are created, so that the first window picks up the custom icon at
   * construction time rather than flashing the default icon.
   *
   * Synchronous and does no I/O: reads the pref, resolves it against the
   * catalog, and pushes the resource ID to WinTaskbar. If the id is no longer
   * in the catalog, ensureAppliedOrRevert() reconciles later.
   *
   * Intended to be called from a browser-before-ui-startup hook.
   */
  applyRuntimeOverrideForStartup() {
    if (AppConstants.platform !== "win") {
      return;
    }
    let entry = CATALOG[this.currentId];
    if (!entry) {
      return;
    }
    applyRuntimeWindowsIcon(entry.iconResourceId);
  },

  /**
   * Reconcile pref state with the shipped catalog at startup. If a custom icon
   * is recorded in prefs and still exists in this build's catalog, push it to
   * runtime windows. If the id is unknown (e.g. an older build that never
   * shipped it, or an icon removed from the catalog), revert the .lnks to the
   * default and clear the pref.
   *
   * Intended to be called from StartupOSIntegration once per process.
   *
   * @returns {Promise<void>}
   */
  async ensureAppliedOrRevert() {
    if (AppConstants.platform !== "win") {
      return;
    }

    let id = this.currentId;
    if (!id) {
      return;
    }

    let entry = CATALOG[id];
    if (!entry) {
      lazy.logConsole.warn(`Custom icon id not in catalog, reverting: ${id}`);
      await this.revert();
      return;
    }

    applyRuntimeWindowsIcon(entry.iconResourceId);
  },
};

XPCOMUtils.defineLazyPreferenceGetter(
  CustomIconManager,
  "currentId",
  PREF_ICON_ID,
  ""
);
