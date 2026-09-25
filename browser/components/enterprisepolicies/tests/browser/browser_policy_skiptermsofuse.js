/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_task(async function test_skip_terms_of_use_timestamp_set() {
  const startTime = Date.now();
  await setupPolicyEngineWithJson({
    policies: {
      SkipTermsOfUse: true,
    },
  });
  const endTime = Date.now();

  Assert.greater(
    parseInt(Services.prefs.getStringPref("termsofuse.acceptedDate")),
    startTime,
    "Terms of use accepted date is greater than start time."
  );
  Assert.greaterOrEqual(
    endTime,
    parseInt(Services.prefs.getStringPref("termsofuse.acceptedDate")),
    "Terms of use accepted date is less than or equal to end time."
  );
});
