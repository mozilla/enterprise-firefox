/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

Services.scriptloader.loadSubScript(
  "chrome://mochitests/content/browser/toolkit/mozapps/update/tests/browser/head.js",
  this
);

add_task(async function consumer_elements_removed_and_managed_notice_shown() {
  let aboutDialog = await waitForAboutDialog();
  let doc = aboutDialog.document;

  for (let id of [
    "contributeDesc",
    "contributeDescReferrals",
    "aboutDialogHelpLink",
    "submit-feedback",
  ]) {
    is(doc.getElementById(id), null, `${id} is not present`);
  }

  for (let l10nId of ["bottom-links-terms", "bottom-links-privacy"]) {
    is(
      doc.querySelector(`[data-l10n-id="${l10nId}"]`),
      null,
      `${l10nId} footer link is not present`
    );
  }

  ok(
    doc.querySelector('[data-l10n-id="bottomLinks-license"]'),
    "Licensing information footer link is still present"
  );

  let relNotes = doc.getElementById("releasenotes");
  ok(!relNotes.hidden, "Release notes link is shown");
  ok(
    /^https:\/\/www\.firefox\.com\/[^/]+\/firefox\/enterprise\/[^/]+\/releasenotes\/(\?|$)/.test(
      relNotes.href
    ),
    `Release notes link points to enterprise release notes: ${relNotes.href}`
  );

  let managedDesc = doc.getElementById("managedDesc");
  ok(managedDesc, "Managed-by-organization notice is present");
  is(
    managedDesc.querySelector("label"),
    null,
    "Managed notice is plain text, not a link"
  );
  await TestUtils.waitForCondition(
    () => managedDesc.textContent.trim(),
    "Waiting for the managed notice to be localized"
  );
  ok(
    managedDesc.compareDocumentPosition(doc.getElementById("communityDesc")) &
      Node.DOCUMENT_POSITION_FOLLOWING,
    "Managed notice appears above the community blurb"
  );

  aboutDialog.close();
});

add_task(async function experimental_warning_names_the_channel() {
  let aboutDialog = await waitForAboutDialog();
  let doc = aboutDialog.document;

  let experimental = doc.getElementById("experimental");
  if (experimental.hidden) {
    info("Not a nightly build, no experimental warning to check");
  } else {
    is(
      doc.getElementById("warningDesc").getAttribute("data-l10n-id"),
      "aboutdialog-nightly-channel-warning",
      "Experimental warning names the release channel instead of the brand"
    );
  }

  aboutDialog.close();
});
