/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const PREF_ICON_ID = "browser.shell.customIcon.id";

/**
 * Inlined catalog of selectable icons. Each entry has:
 *
 *   iconResourceId: the Win32 resource ID of an icon embedded in firefox.exe
 *     at build time (declared in toolkit/xre/nsNativeAppSupportWin.h and
 *     browser/app/splash.rc). This is what gets applied: shortcuts reference
 *     it as firefox.exe,-<iconResourceId> and live windows load it directly.
 *     The catalog-id -> resource-id mapping is ABI: never remap or reuse an id
 *     once it has shipped, even if the icon is retired from the picker.
 *   preview: a chrome:// URI resolving to the same .ico shipped in omni.ja
 *     (see browser/components/shell/jar.mn). Used only to render a thumbnail in
 *     the about:settings picker; never used to apply the icon. PE resources are
 *     not addressable by a URL, hence the separate display asset.
 *   l10nId: Fluent id for the icon's about:settings label.
 *   gated: if true, the icon is a "Bonus" icon, offered only once the browser is
 *     both the default browser and pinned to the taskbar. This is purely an
 *     about:settings policy (the UI disables the option); CustomIconManager
 *     itself does not enforce it.
 *
 * Theme-aware icons (e.g. Minimal, a monochrome silhouette that's only legible
 * against a matching background) instead carry a `variants` object keyed by
 * color scheme ("dark"/"light"), each with its own iconResourceId + preview.
 * `iconResourceId`/`preview` are read through resolveResourceId()/resolvePreview()
 * so callers don't special-case theme-aware entries: the applied resource is
 * chosen by the OS theme (the taskbar background), while the about:settings
 * preview is chosen by the document's own color scheme (the surface it renders
 * on). These differ only when the browser theme is overridden away from the OS.
 */
export const ICON_CATALOG = Object.freeze({
  default: Object.freeze({
    // The executable's own icon. "default" is the no-override state, selected by
    // reverting (clearing the pref), so this resource id is never applied
    // directly; the entry exists to give the picker a label and a preview. The
    // preview is icon64 (rather than icon32) so it stays crisp on hi-dpi.
    iconResourceId: 0,
    preview: "chrome://branding/content/icon64.png",
    l10nId: "appearance-browser-icon-default",
  }),
  retro2004: Object.freeze({
    iconResourceId: 1100, // IDI_CUSTOM_RETRO2004
    preview: "chrome://browser/content/icons/retro2004.ico",
    l10nId: "appearance-browser-icon-retro2004",
  }),
  retro2017: Object.freeze({
    iconResourceId: 1101, // IDI_CUSTOM_RETRO2017
    preview: "chrome://browser/content/icons/retro2017.ico",
    l10nId: "appearance-browser-icon-retro2017",
  }),
  pride: Object.freeze({
    iconResourceId: 1106, // IDI_CUSTOM_PRIDE
    preview: "chrome://browser/content/icons/pride.ico",
    l10nId: "appearance-browser-icon-pride",
  }),
  minimal: Object.freeze({
    l10nId: "appearance-browser-icon-minimal",
    variants: Object.freeze({
      dark: Object.freeze({
        iconResourceId: 1102, // IDI_CUSTOM_MINIMAL_DARK
        preview: "chrome://browser/content/icons/minimal-dark.ico",
      }),
      light: Object.freeze({
        iconResourceId: 1103, // IDI_CUSTOM_MINIMAL_LIGHT
        preview: "chrome://browser/content/icons/minimal-light.ico",
      }),
    }),
  }),
  kit: Object.freeze({
    iconResourceId: 1107, // IDI_CUSTOM_KIT
    preview: "chrome://browser/content/icons/kit.ico",
    l10nId: "appearance-browser-icon-kit",
    gated: true,
  }),
  pixelated: Object.freeze({
    iconResourceId: 1104, // IDI_CUSTOM_PIXELATED
    preview: "chrome://browser/content/icons/pixelated.ico",
    l10nId: "appearance-browser-icon-pixelated",
    gated: true,
  }),
  momo: Object.freeze({
    iconResourceId: 1105, // IDI_CUSTOM_MOMO
    preview: "chrome://browser/content/icons/momo.ico",
    l10nId: "appearance-browser-icon-momo",
    gated: true,
  }),
});

/**
 * Resolve a catalog entry's variant for a color scheme. Flat (theme-agnostic)
 * entries are returned as-is; theme-aware entries return their dark/light
 * variant.
 *
 * @param {object} entry A catalog entry.
 * @param {"dark"|"light"} scheme
 * @returns {object} An object with iconResourceId + preview.
 */
function resolveVariant(entry, scheme) {
  return entry.variants ? entry.variants[scheme] : entry;
}

/**
 * The embedded resource ID to apply for an entry, given the OS color scheme.
 * Exported for tests; the manager itself resolves against the OS taskbar theme.
 *
 * @param {object} entry A catalog entry.
 * @param {"dark"|"light"} scheme The OS color scheme.
 * @returns {number}
 */
export function resolveResourceId(entry, scheme) {
  return resolveVariant(entry, scheme).iconResourceId;
}

/**
 * The preview URI to display for an entry, given a color scheme. Exported for
 * the about:settings picker, which resolves against the document's own color
 * scheme rather than the OS theme.
 *
 * @param {object} entry A catalog entry.
 * @param {"dark"|"light"} scheme
 * @returns {string}
 */
export function resolvePreview(entry, scheme) {
  return resolveVariant(entry, scheme).preview;
}

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
 *        1100 for IDI_CUSTOM_RETRO2004), or 0 for the executable's default icon.
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

// Values of the Personalize\SystemUsesLightTheme registry value (the OS "Windows
// mode" that governs the taskbar). Exported so tests can drive osColorScheme().
export const OS_LIGHT = 1;
export const OS_DARK = 0;

/**
 * The OS color scheme that governs the taskbar / Start Menu background, where
 * applied shortcut icons are shown. Read from the Windows "system" theme
 * setting (Personalize\SystemUsesLightTheme) so it reflects the OS regardless
 * of any browser theme override - the taskbar follows the OS, not Firefox.
 * There is no JS API for this (LookAndFeel is C++-only; nsIXULRuntime exposes
 * only the browser-derived chrome scheme), so we read the registry directly,
 * as Gecko's own nsLookAndFeel does.
 *
 * @returns {"dark"|"light"}
 */
function osColorScheme() {
  let key = Cc["@mozilla.org/windows-registry-key;1"].createInstance(
    Ci.nsIWindowsRegKey
  );
  try {
    key.open(
      Ci.nsIWindowsRegKey.ROOT_KEY_CURRENT_USER,
      "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
      Ci.nsIWindowsRegKey.ACCESS_READ
    );
    // Absent on older Windows, which only had the light theme.
    if (key.hasValue("SystemUsesLightTheme")) {
      return key.readIntValue("SystemUsesLightTheme") === OS_DARK
        ? "dark"
        : "light";
    }
  } catch (ex) {
    lazy.logConsole.warn("Could not read OS theme; assuming light.", ex);
  } finally {
    try {
      key.close();
    } catch (ex) {}
  }
  return "light";
}

// The OS scheme used the last time the active icon was applied, so a
// look-and-feel change that doesn't flip the taskbar theme (font/color changes
// also fire the notification) is ignored.
let gLastAppliedScheme = null;
let gThemeObserverRegistered = false;

// When the OS taskbar theme flips, re-apply the active icon so a theme-aware
// icon (e.g. Minimal) swaps to the legible variant without user action. The
// observer is registered once at startup and unregisters itself at shutdown;
// observe() is a no-op unless a theme-aware icon is currently active.
const gThemeObserver = {
  observe(subject, topic) {
    if (topic === "xpcom-shutdown") {
      Services.obs.removeObserver(this, "look-and-feel-changed");
      Services.obs.removeObserver(this, "xpcom-shutdown");
      return;
    }
    let entry = ICON_CATALOG[CustomIconManager.currentId];
    if (entry?.variants && osColorScheme() !== gLastAppliedScheme) {
      CustomIconManager.apply(CustomIconManager.currentId).catch(ex =>
        lazy.logConsole.error("Re-applying icon after theme change failed", ex)
      );
    }
  },
};

// Register the theme observer for the life of the process. Called once from
// startup (before any icon is chosen) so icons selected mid-session are also
// covered; the observer removes itself on xpcom-shutdown.
function registerThemeObserver() {
  if (gThemeObserverRegistered) {
    return;
  }
  gThemeObserverRegistered = true;
  Services.obs.addObserver(gThemeObserver, "look-and-feel-changed");
  Services.obs.addObserver(gThemeObserver, "xpcom-shutdown");
}

export const CustomIconManager = {
  /**
   * Make the icon identified by `id` the active custom icon for this
   * install. On Windows this:
   *
   *   1. Updates every per-user .lnk this install owns to reference the
   *      embedded icon resource (firefox.exe,-<resource-id>).
   *   2. Records the choice in a pref.
   *   3. Pushes the icon to live windows via WM_SETICON.
   *
   * @param {string} id A key in ICON_CATALOG.
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
        "Custom browser icons are not supported on MSIX (packaged) builds."
      );
    }

    let entry = ICON_CATALOG[id];
    if (!entry) {
      throw new Error(`Unknown icon id: ${id}`);
    }

    let scheme = osColorScheme();
    let iconResourceId = resolveResourceId(entry, scheme);

    let updated = await applyIconToWindowsShortcuts(
      browserExePath(),
      iconResourceId
    );
    if (!updated) {
      lazy.logConsole.warn(
        `apply("${id}"): no Windows shortcuts were updated. The running ` +
          `window icon will change, but desktop/Start Menu/taskbar shortcuts ` +
          `will not. See the log above for why.`
      );
    }

    Services.prefs.setStringPref(PREF_ICON_ID, id);
    applyRuntimeWindowsIcon(iconResourceId);
    gLastAppliedScheme = scheme;
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
    if (Services.sysinfo.getProperty("hasWinPackageId")) {
      return;
    }
    // Register before the no-icon early-return so icons chosen later in the
    // session are still re-applied when the OS theme flips.
    registerThemeObserver();
    let entry = ICON_CATALOG[this.currentId];
    if (!entry) {
      return;
    }
    applyRuntimeWindowsIcon(resolveResourceId(entry, osColorScheme()));
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

    if (Services.sysinfo.getProperty("hasWinPackageId")) {
      return;
    }

    let id = this.currentId;
    if (!id) {
      return;
    }

    let entry = ICON_CATALOG[id];
    if (!entry) {
      lazy.logConsole.warn(`Custom icon id not in catalog, reverting: ${id}`);
      await this.revert();
      return;
    }

    if (entry.variants) {
      // The OS theme may have flipped while the browser was closed, so re-apply
      // the matching variant to shortcuts + runtime, and start watching for
      // further changes.
      await this.apply(id);
      return;
    }

    applyRuntimeWindowsIcon(resolveResourceId(entry, osColorScheme()));
  },
};

XPCOMUtils.defineLazyPreferenceGetter(
  CustomIconManager,
  "currentId",
  PREF_ICON_ID,
  ""
);
