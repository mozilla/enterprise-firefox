/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
});

const SMBIOS_RAW_TABLE_SIGNATURE = 0x52534d42;

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
  try {
    let content = await IOUtils.readUTF8("/etc/machine-id");
    return content.trim();
  } catch (e) {
    console.error("MachineId: Failed to read /etc/machine-id:", e);
    return null;
  }
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
  let biosSerial = null;

  for (let offset = 0; offset + 4 <= tableBytes.length; ) {
    let type = tableBytes[offset];
    let formattedLength = tableBytes[offset + 1];

    if (formattedLength < 4 || offset + formattedLength > tableBytes.length) {
      break;
    }

    if (type === 1 && formattedLength >= 0x19) {
      let uuid = formatWindowsUuid(tableBytes.slice(offset + 8, offset + 24));
      if (uuid) {
        return uuid;
      }
    }

    if (type === 0 && formattedLength >= 0x09 && !biosSerial) {
      biosSerial =
        getSmbiosString(
          tableBytes,
          offset,
          formattedLength,
          tableBytes[offset + 8]
        ) || biosSerial;
    }

    if (type === 127) {
      break;
    }

    offset = getNextSmbiosStructureOffset(tableBytes, offset, formattedLength);
  }

  return biosSerial;
}

function getWindowsFirmwareMachineId() {
  const { ctypes } = ChromeUtils.importESModule(
    "resource://gre/modules/ctypes.sys.mjs"
  );
  const DWORD = ctypes.uint32_t;
  const BYTE = ctypes.uint8_t;

  let kernel32 = ctypes.open("kernel32");
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
    return machineGuid || null;
  } catch (e) {
    console.error("MachineId: Failed to get Windows machine ID:", e);
    return null;
  }
}

async function getMacMachineId() {
  try {
    let proc = await lazy.Subprocess.call({
      command: "/usr/sbin/ioreg",
      arguments: ["-rd1", "-c", "IOPlatformExpertDevice"],
    });

    let output = "";
    let chunk;
    while ((chunk = await proc.stdout.readString())) {
      output += chunk;
    }
    await proc.wait();

    let match = output.match(/"IOPlatformSerialNumber"\s*=\s*"([^"]+)"/);
    if (match) {
      return match[1];
    }

    match = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
    if (match) {
      return match[1];
    }

    return null;
  } catch (e) {
    console.error("MachineId: Failed to get macOS machine ID:", e);
    return null;
  }
}

let cachedRawId = undefined;
let cachedHashedId = undefined;

export const MachineId = {
  async getRawId() {
    if (cachedRawId !== undefined) {
      return cachedRawId;
    }

    let id = null;
    switch (AppConstants.platform) {
      case "linux":
        id = await getLinuxMachineId();
        break;
      case "win":
        id = await getWindowsMachineId();
        break;
      case "macosx":
        id = await getMacMachineId();
        break;
      default:
        console.warn("MachineId: Unsupported platform:", AppConstants.platform);
    }

    cachedRawId = id;
    return id;
  },

  async getHashedId() {
    if (cachedHashedId !== undefined) {
      return cachedHashedId;
    }

    let rawId = await this.getRawId();
    if (!rawId) {
      return null;
    }

    cachedHashedId = await sha256Hex(rawId);
    return cachedHashedId;
  },

  clearCache() {
    cachedRawId = undefined;
    cachedHashedId = undefined;
  },

  _parseWindowsFirmwareTable: parseWindowsFirmwareTable,
};
