/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

add_setup(async function test_common_initialize() {
  do_get_profile();
  // Initialize FOG for Glean telemetry testing
  Services.fog.initializeFOG();
});
