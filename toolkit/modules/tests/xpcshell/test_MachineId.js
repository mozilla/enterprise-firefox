/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

const { MachineId } = ChromeUtils.importESModule(
  "resource://gre/modules/MachineId.sys.mjs"
);

function makeRawSmbiosTable(structures) {
  let tableData = structures.flat();
  let length = tableData.length;
  return [0, 3, 2, 0, length & 0xff, (length >> 8) & 0xff, 0, 0].concat(
    tableData
  );
}

function makeType1SystemInformation(uuidBytes) {
  return [
    1,
    0x19,
    0,
    0,
    1,
    2,
    0,
    0,
    ...uuidBytes,
    0,
    "S".charCodeAt(0),
    "y".charCodeAt(0),
    "s".charCodeAt(0),
    0,
    0,
  ];
}

function makeType0BiosInformation(serial) {
  let serialBytes = Array.from(serial, char => char.charCodeAt(0));
  return [
    0,
    0x12,
    0,
    0,
    1,
    0,
    2,
    0,
    3,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    "V".charCodeAt(0),
    "e".charCodeAt(0),
    "n".charCodeAt(0),
    "d".charCodeAt(0),
    "o".charCodeAt(0),
    "r".charCodeAt(0),
    0,
    "B".charCodeAt(0),
    "I".charCodeAt(0),
    "O".charCodeAt(0),
    "S".charCodeAt(0),
    0,
    ...serialBytes,
    0,
    0,
  ];
}

function makeEndOfTable() {
  return [127, 4, 0, 0, 0, 0];
}

add_task(function test_parse_windows_firmware_table_prefers_uuid() {
  let uuidBytes = [
    0x67, 0x45, 0x23, 0x01, 0xab, 0x89, 0xef, 0xcd, 0x10, 0x32, 0x54, 0x76,
    0x98, 0xba, 0xdc, 0xfe,
  ];
  let rawTable = makeRawSmbiosTable([
    makeType1SystemInformation(uuidBytes),
    makeType0BiosInformation("BIOS-SERIAL"),
    makeEndOfTable(),
  ]);

  equal(
    MachineId._parseWindowsFirmwareTable(rawTable),
    "01234567-89ab-cdef-1032-547698badcfe"
  );
});

add_task(
  function test_parse_windows_firmware_table_falls_back_to_bios_serial() {
    let rawTable = makeRawSmbiosTable([
      makeType1SystemInformation(new Array(16).fill(0)),
      makeType0BiosInformation("BIOS-SERIAL"),
      makeEndOfTable(),
    ]);

    equal(MachineId._parseWindowsFirmwareTable(rawTable), "BIOS-SERIAL");
  }
);

add_task(function test_parse_windows_firmware_table_rejects_all_ff_uuid() {
  let rawTable = makeRawSmbiosTable([
    makeType1SystemInformation(new Array(16).fill(0xff)),
    makeType0BiosInformation("BIOS-SERIAL"),
    makeEndOfTable(),
  ]);

  equal(MachineId._parseWindowsFirmwareTable(rawTable), "BIOS-SERIAL");
});

add_task(function test_parse_windows_firmware_table_no_type1() {
  let rawTable = makeRawSmbiosTable([
    makeType0BiosInformation("BIOS-SERIAL"),
    makeEndOfTable(),
  ]);

  equal(MachineId._parseWindowsFirmwareTable(rawTable), "BIOS-SERIAL");
});

add_task(function test_parse_windows_firmware_table_no_identifiers() {
  let rawTable = makeRawSmbiosTable([makeEndOfTable()]);

  equal(MachineId._parseWindowsFirmwareTable(rawTable), null);
});
