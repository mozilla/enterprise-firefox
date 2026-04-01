/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

// The winter time abbreviation for London should be
// "GMT" in British English even prior to 1971-10-31.

let parts = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  timeZoneName: "short"
}).formatToParts(new Date("1968-01-01"));

let part = parts.find(p => p.type == "timeZoneName");

assertEq(part.type, "timeZoneName");
assertEq(part.value, "GMT");

if (typeof reportCompare === "function") {
    reportCompare(0, 0, "ok");
}
