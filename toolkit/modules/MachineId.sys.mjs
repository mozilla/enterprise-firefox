/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

// Upper bound on the macOS `ioreg` shell-out. The machine ID is awaited on the
// Sync-startup, policy-fetch, and about:support paths, so a wedged `ioreg`
// must not be able to stall them indefinitely.
const MAC_MACHINE_ID_TIMEOUT_MS = 5000;

ChromeUtils.defineLazyGetter(lazy, "log", () =>
  console.createInstance({
    prefix: "MachineId",
    maxLogLevel: "Info",
    maxLogLevelPref: "toolkit.machineid.loglevel",
  })
);

const SMBIOS_RAW_TABLE_SIGNATURE = 0x52534d42;

// Namespace prefix mixed into the machine ID before hashing so the resulting
// digest is specific to this application and cannot be correlated with hashes
// of the same platform identifier produced by other software.
const MACHINE_ID_HASH_NAMESPACE = "firefox-machine-id";

async function sha256Hex(message) {
  let hasher = Cc["@mozilla.org/security/hash;1"].createInstance(
    Ci.nsICryptoHash
  );
  hasher.init(hasher.SHA256);
  let encoder = new TextEncoder();
  let data = encoder.encode(message);
  hasher.update(data, data.length);
  let hash = hasher.finish(false);
  return Array.from(hash, c =>
    c.charCodeAt(0).toString(16).padStart(2, "0")
  ).join("");
}

async function getLinuxMachineId() {
  // /etc/machine-id is the canonical location, but on some systems it is only
  // present at the legacy D-Bus path, so fall back to that.
  const sources = [
    { path: "/etc/machine-id", source: "etc-machine-id" },
    { path: "/var/lib/dbus/machine-id", source: "dbus-machine-id" },
  ];
  for (let { path, source } of sources) {
    try {
      let id = (await IOUtils.readUTF8(path)).trim();
      if (id) {
        return { id, source };
      }
    } catch (e) {
      if (e.name !== "NotFoundError") {
        lazy.log.error(`Failed to read ${path}:`, e);
      }
    }
  }
  return null;
}

function readUint32LE(bytes, offset) {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

function bytesToHex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function formatWindowsUuid(bytes) {
  if (bytes.length !== 16) {
    return null;
  }
  if (
    bytes.every(byte => byte === 0x00) ||
    bytes.every(byte => byte === 0xff)
  ) {
    return null;
  }
  return [
    bytesToHex([bytes[3], bytes[2], bytes[1], bytes[0]]),
    bytesToHex([bytes[5], bytes[4]]),
    bytesToHex([bytes[7], bytes[6]]),
    bytesToHex([bytes[8], bytes[9]]),
    bytesToHex(bytes.slice(10, 16)),
  ].join("-");
}

function getSmbiosString(bytes, structureOffset, formattedLength, stringIndex) {
  if (!stringIndex) {
    return null;
  }

  let stringOffset = structureOffset + formattedLength;
  let currentIndex = 1;

  while (stringOffset < bytes.length && bytes[stringOffset] !== 0) {
    let endOffset = stringOffset;
    while (endOffset < bytes.length && bytes[endOffset] !== 0) {
      endOffset++;
    }

    if (currentIndex === stringIndex) {
      return String.fromCharCode(
        ...bytes.slice(stringOffset, endOffset)
      ).trim();
    }

    currentIndex++;
    stringOffset = endOffset + 1;
  }

  return null;
}

function getNextSmbiosStructureOffset(bytes, structureOffset, formattedLength) {
  let offset = structureOffset + formattedLength;

  while (offset + 1 < bytes.length) {
    if (bytes[offset] === 0 && bytes[offset + 1] === 0) {
      return offset + 2;
    }
    offset++;
  }

  return bytes.length;
}

function parseWindowsFirmwareTable(rawTableBytes) {
  if (rawTableBytes.length < 8) {
    return null;
  }

  let tableLength = readUint32LE(rawTableBytes, 4);
  let tableBytes = rawTableBytes.slice(8, 8 + tableLength);
  let systemSerial = null;

  for (let offset = 0; offset + 4 <= tableBytes.length; ) {
    let type = tableBytes[offset];
    let formattedLength = tableBytes[offset + 1];

    if (formattedLength < 4 || offset + formattedLength > tableBytes.length) {
      break;
    }

    // SMBIOS Type 1 (System Information) carries the per-machine identifiers:
    // the UUID at offset 0x08 and the serial number string index at 0x07.
    if (type === 1) {
      if (formattedLength >= 0x19) {
        let uuid = formatWindowsUuid(tableBytes.slice(offset + 8, offset + 24));
        if (uuid) {
          return { id: uuid, source: "firmware-uuid" };
        }
      }

      if (formattedLength >= 0x08 && !systemSerial) {
        systemSerial = getSmbiosString(
          tableBytes,
          offset,
          formattedLength,
          tableBytes[offset + 7]
        );
      }
    }

    if (type === 127) {
      break;
    }

    offset = getNextSmbiosStructureOffset(tableBytes, offset, formattedLength);
  }

  return systemSerial ? { id: systemSerial, source: "system-serial" } : null;
}

function getWindowsFirmwareMachineId() {
  const { ctypes } = ChromeUtils.importESModule(
    "resource://gre/modules/ctypes.sys.mjs"
  );
  const DWORD = ctypes.uint32_t;
  const BYTE = ctypes.uint8_t;

  let kernel32 = ctypes.open("Kernel32");
  try {
    let GetSystemFirmwareTable = kernel32.declare(
      "GetSystemFirmwareTable",
      ctypes.winapi_abi,
      DWORD,
      DWORD,
      DWORD,
      ctypes.voidptr_t,
      DWORD
    );

    let size = GetSystemFirmwareTable(SMBIOS_RAW_TABLE_SIGNATURE, 0, null, 0);
    if (!size) {
      return null;
    }

    let buffer = ctypes.ArrayType(BYTE, size)();
    let bytesWritten = GetSystemFirmwareTable(
      SMBIOS_RAW_TABLE_SIGNATURE,
      0,
      buffer.address(),
      size
    );
    if (!bytesWritten) {
      return null;
    }

    let rawTableBytes = Array.from(buffer).slice(0, bytesWritten);
    return parseWindowsFirmwareTable(rawTableBytes);
  } finally {
    kernel32.close();
  }
}

function getWindowsMachineGuid() {
  const { WindowsRegistry } = ChromeUtils.importESModule(
    "resource://gre/modules/WindowsRegistry.sys.mjs"
  );
  return WindowsRegistry.readRegKey(
    Ci.nsIWindowsRegKey.ROOT_KEY_LOCAL_MACHINE,
    "SOFTWARE\\Microsoft\\Cryptography",
    "MachineGuid"
  );
}

async function getWindowsMachineId() {
  try {
    let firmwareId = getWindowsFirmwareMachineId();
    if (firmwareId) {
      return firmwareId;
    }

    let machineGuid = getWindowsMachineGuid();
    return machineGuid ? { id: machineGuid, source: "machine-guid" } : null;
  } catch (e) {
    lazy.log.error("Failed to get Windows machine ID:", e);
    return null;
  }
}

async function getMacMachineId() {
  try {
    let proc = await lazy.Subprocess.call({
      command: "/usr/sbin/ioreg",
      arguments: ["-rd1", "-c", "IOPlatformExpertDevice"],
    });

    // Bound the read: if `ioreg` wedges, kill it so the awaiting callers (Sync
    // startup, policy fetch, about:support) are not stalled indefinitely.
    let timedOut = false;
    let timer = lazy.setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, MAC_MACHINE_ID_TIMEOUT_MS);

    let output = "";
    try {
      let chunk;
      while ((chunk = await proc.stdout.readString())) {
        output += chunk;
      }
      await proc.wait();
    } finally {
      lazy.clearTimeout(timer);
    }

    if (timedOut) {
      lazy.log.error("Timed out reading macOS machine ID from ioreg");
      return null;
    }

    let match = output.match(/"IOPlatformSerialNumber"\s*=\s*"([^"]+)"/);
    if (match) {
      return { id: match[1], source: "ioplatform-serial" };
    }

    match = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
    if (match) {
      return { id: match[1], source: "ioplatform-uuid" };
    }

    return null;
  } catch (e) {
    lazy.log.error("Failed to get macOS machine ID:", e);
    return null;
  }
}

// Cached { id, source } object (or null) returned by the platform collectors.
let cachedResolved = undefined;
// In-flight resolution, so concurrent first-callers share one collection
// rather than each shelling out (e.g. to `ioreg`) or re-reading the firmware
// table.
let resolvePromise = null;
let cachedHashedId = undefined;

async function resolveMachineId() {
  switch (AppConstants.platform) {
    case "linux":
      return getLinuxMachineId();
    case "win":
      return getWindowsMachineId();
    case "macosx":
      return getMacMachineId();
    default:
      lazy.log.warn("Unsupported platform:", AppConstants.platform);
      return null;
  }
}

// Two consumers read the machine ID with different persistence expectations:
//   - Sync client records (services/sync) use getHashedId(): they persist on
//     the server, so a hash is stored rather than the raw serial.
//   - The enterprise console device posture (ConsoleClient) uses getRawId()
//     plus getSource(): it keys devices by serial and retrieves it more
//     ephemerally.
export const MachineId = {
  // Resolves the machine ID to a { id, source } object (or null) and caches it.
  // The source tier the identifier came from is logged once so that a change of
  // source (e.g. a device serial becoming unavailable) is diagnosable. The raw
  // identifier itself is never logged.
  async _resolve() {
    if (cachedResolved !== undefined) {
      return cachedResolved;
    }

    resolvePromise ??= (async () => {
      try {
        let resolved = await resolveMachineId();
        if (resolved) {
          lazy.log.info(`Using "${resolved.source}" as machine ID source`);
        } else {
          lazy.log.warn("No machine ID source available");
        }
        cachedResolved = resolved;
        return resolved;
      } finally {
        resolvePromise = null;
      }
    })();

    return resolvePromise;
  },

  async getRawId() {
    let resolved = await this._resolve();
    return resolved ? resolved.id : null;
  },

  async getSource() {
    let resolved = await this._resolve();
    return resolved ? resolved.source : null;
  },

  async getHashedId() {
    if (cachedHashedId !== undefined) {
      return cachedHashedId;
    }

    let rawId = await this.getRawId();
    if (!rawId) {
      return null;
    }

    cachedHashedId = await sha256Hex(`${MACHINE_ID_HASH_NAMESPACE}:${rawId}`);
    return cachedHashedId;
  },

  clearCache() {
    cachedResolved = undefined;
    resolvePromise = null;
    cachedHashedId = undefined;
  },

  _parseWindowsFirmwareTable: parseWindowsFirmwareTable,
};
