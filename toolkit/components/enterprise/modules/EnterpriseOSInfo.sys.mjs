/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  createEnterpriseLogger:
    "resource://gre/modules/enterprise/EnterpriseCommon.sys.mjs",
  WindowsRegistry: "resource://gre/modules/WindowsRegistry.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  return lazy.createEnterpriseLogger("EnterpriseOSInfo");
});

const WINDOWS_CURRENT_VERSION_KEY =
  "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion";

const MACOS_SYSTEM_VERSION_PLIST =
  "/System/Library/CoreServices/SystemVersion.plist";

let gMacOSVersionPromise = null;

/**
 * Reads the macOS version from SystemVersion.plist.
 *
 * @returns {Promise<string|null>}
 */
// TODO: Once bug 2017277 is fixed, os.version can be used instead of this function.
async function getMacOSVersion() {
  if (gMacOSVersionPromise) {
    return gMacOSVersionPromise;
  }
  gMacOSVersionPromise = (async () => {
    try {
      const content = await IOUtils.readUTF8(MACOS_SYSTEM_VERSION_PLIST);
      const doc = new DOMParser().parseFromString(content, "application/xml");
      for (const key of doc.querySelectorAll("dict > key")) {
        if (key.textContent === "ProductVersion") {
          return key.nextElementSibling?.textContent ?? null;
        }
      }
    } catch (e) {
      lazy.log.error("getMacOSVersion: failed to read SystemVersion.plist", e);
    }
    return null;
  })();
  return gMacOSVersionPromise;
}

/**
 * Returns the Windows release label (e.g. "22H2", "23H2", "1909") from the
 * registry. Prefers DisplayVersion (introduced in 20H2), falls back to
 * ReleaseId for older versions. Returns null if unavailable or not on Windows.
 *
 * @returns {string|null}
 */
function getWindowsReleaseLabel() {
  for (const valueName of ["DisplayVersion", "ReleaseId"]) {
    const value = lazy.WindowsRegistry.readRegKey(
      Ci.nsIWindowsRegKey.ROOT_KEY_LOCAL_MACHINE,
      WINDOWS_CURRENT_VERSION_KEY,
      valueName,
      Ci.nsIWindowsRegKey.WOW64_64
    );
    if (value != null) {
      return value;
    }
  }
  return null;
}

/**
 * Returns true if the current Windows installation is a Server edition.
 *
 * @returns {boolean}
 */
function isWindowsServer() {
  const installationType = lazy.WindowsRegistry.readRegKey(
    Ci.nsIWindowsRegKey.ROOT_KEY_LOCAL_MACHINE,
    WINDOWS_CURRENT_VERSION_KEY,
    "InstallationType",
    Ci.nsIWindowsRegKey.WOW64_64
  );
  return installationType === "Server";
}

const WINDOWS_SERVER_NAMES = [
  [26100, "2025"],
  [20348, "2022"],
  [17763, "2019"],
  [14393, "2016"],
];

/**
 * Returns the Windows Server version string (e.g. "2025", "2022") from a build
 * number, or null if the build number is not recognized.
 *
 * @param {number} buildNumber
 * @returns {string|null}
 */
function getWindowsServerVersion(buildNumber) {
  const match = WINDOWS_SERVER_NAMES.find(([min]) => buildNumber >= min);
  return match ? match[1] : null;
}

const MACOS_NAMES = [
  ["27", "Golden Gate"],
  ["26", "Tahoe"],
  ["15", "Sequoia"],
  ["14", "Sonoma"],
  ["13", "Ventura"],
  ["12", "Monterey"],
  ["11", "Big Sur"],
  ["10.16", "Big Sur"],
  ["10.15", "Catalina"],
];

/**
 * Returns the Windows major version string ("11", "10", or "Unsupported") from
 * a build number.
 *
 * @param {number} buildNumber
 * @returns {string}
 */
function getWindowsMajorVersion(buildNumber) {
  const versions = [
    [22000, "11"],
    [10240, "10"],
  ];
  const match = versions.find(([min]) => buildNumber >= min);
  return match ? match[1] : "Unsupported";
}

/**
 * Composes both the long and short human-readable OS names, reading SystemVersion.plist
 * at most once on macOS.
 *
 * @param {object} os - The system.os object from TelemetryEnvironment.currentEnvironment.
 * @returns {Promise<{long: string|null, short: string|null}>}
 */
export async function composeOSNames(os) {
  const [long, short] = await Promise.all([
    composeOSName(os),
    composeShortOSName(os),
  ]);
  return { long, short };
}

/**
 * Composes a short human-readable OS name from TelemetryEnvironment's system.os object.
 *
 * @param {object} os - The system.os object from TelemetryEnvironment.currentEnvironment.
 * @returns {Promise<string|null>} A short OS string (e.g. "macOS 15 (Sequoia)", "Windows 11",
 *   "Windows Server 2025", "Ubuntu 22.04"), or null if the OS cannot be identified.
 */
async function composeShortOSName(os) {
  if (AppConstants.platform === "macosx") {
    const macosVersion = await getMacOSVersion();
    if (!macosVersion) {
      return null;
    }
    const match = MACOS_NAMES.find(([prefix]) =>
      macosVersion.startsWith(prefix)
    );
    const major = macosVersion.split(".")[0];
    return match ? `macOS ${major} (${match[1]})` : `macOS ${major}`;
  }
  if (os.windowsBuildNumber) {
    if (isWindowsServer()) {
      const serverVersion = getWindowsServerVersion(os.windowsBuildNumber);
      return serverVersion
        ? `Windows Server ${serverVersion}`
        : "Windows Server";
    }
    return `Windows ${getWindowsMajorVersion(os.windowsBuildNumber)}`;
  }
  if (os.distro && os.distroVersion) {
    return `${os.distro} ${os.distroVersion}`;
  }
  lazy.log.error("composeShortOSName: unable to identify OS from", os);
  return null;
}

/**
 * Composes a human-readable OS name from TelemetryEnvironment's system.os object.
 * On macOS, the version is read directly from SystemVersion.plist.
 * On Windows, the installation type and release label are read from the registry.
 *
 * @param {object} os - The system.os object from TelemetryEnvironment.currentEnvironment.
 * @returns {Promise<string|null>} A human-readable OS string (e.g. "macOS 15.3 (Sequoia)",
 *   "Windows 11 22H2 (build 22621)", "Windows Server 2025 (build 26100)",
 *   "Ubuntu 22.04 (5.15.0)"), or null if the OS cannot be identified.
 */
async function composeOSName(os) {
  if (AppConstants.platform === "macosx") {
    const macosVersion = await getMacOSVersion();
    if (!macosVersion) {
      return null;
    }
    const match = MACOS_NAMES.find(([prefix]) =>
      macosVersion.startsWith(prefix)
    );
    return match
      ? `macOS ${macosVersion} (${match[1]})`
      : `macOS ${macosVersion}`;
  }
  if (os.windowsBuildNumber) {
    const releaseLabel = getWindowsReleaseLabel();
    const releaseSuffix = releaseLabel ? ` ${releaseLabel}` : "";
    if (isWindowsServer()) {
      const serverVersion = getWindowsServerVersion(os.windowsBuildNumber);
      const prefix = serverVersion
        ? `Windows Server ${serverVersion}`
        : "Windows Server";
      return `${prefix}${releaseSuffix} (build ${os.windowsBuildNumber})`;
    }
    // Maps minimum build numbers to Windows major versions, since
    // windowsBuildNumber is more reliable than the version string for
    // distinguishing Windows 10 from 11.
    const major = getWindowsMajorVersion(os.windowsBuildNumber);
    return `Windows ${major}${releaseSuffix} (build ${os.windowsBuildNumber})`;
  }
  if (os.distro && os.distroVersion && os.version) {
    return `${os.distro} ${os.distroVersion} (${os.version})`;
  }
  lazy.log.error("composeOSName: unable to identify OS from", os);
  return null;
}
