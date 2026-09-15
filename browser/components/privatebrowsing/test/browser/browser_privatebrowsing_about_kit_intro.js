/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const REDESIGN_PREF = "browser.privateWindowRedesign.enabled";
const SHOWN_PREF = "browser.privatebrowsing.introAnimationShown";

// Without the experiment the intro stays hidden and the static logo shows.
add_task(async function test_intro_absent_without_experiment() {
  await SpecialPowers.pushPrefEnv({ set: [[REDESIGN_PREF, false]] });

  let { win, tab } = await openTabAndWaitForRender();
  await SpecialPowers.spawn(tab, [], async function () {
    const intro = content.document.querySelector("private-browsing-mask-intro");
    const logo = content.document.getElementById("about-private-browsing-logo");
    ok(intro, "The intro component exists in the markup");
    ok(intro.hidden, "The intro is hidden when the experiment is off");
    ok(
      !logo.hidden,
      "The static mask logo is shown when the experiment is off"
    );
  });

  await BrowserTestUtils.closeWindow(win);
  await SpecialPowers.popPrefEnv();
});

// With the experiment on and unseen, the intro replaces the logo and plays.
add_task(async function test_intro_plays_on_first_run() {
  await SpecialPowers.pushPrefEnv({
    set: [
      [REDESIGN_PREF, true],
      [SHOWN_PREF, false],
      ["ui.prefersReducedMotion", 0],
    ],
  });

  let { win, tab } = await openTabAndWaitForRender();
  await SpecialPowers.spawn(tab, [], async function () {
    const intro = content.document.querySelector("private-browsing-mask-intro");
    const logo = content.document.getElementById("about-private-browsing-logo");
    ok(!intro.hidden, "The intro is shown when the experiment is on");
    ok(logo.hidden, "The static mask logo is hidden when the experiment is on");
    ok(intro.wrappedJSObject.play, "The intro plays on the first run");

    await intro.wrappedJSObject.updateComplete;
    const circle = intro.shadowRoot.querySelector(".circle");
    ok(
      circle.classList.contains("playing"),
      "The circle is in the playing state"
    );
  });

  await BrowserTestUtils.closeWindow(win);
  await SpecialPowers.popPrefEnv();
});

// Once the seen-once flag is set, the intro shows its final state and does not replay.
add_task(async function test_intro_does_not_replay_when_seen() {
  await SpecialPowers.pushPrefEnv({
    set: [
      [REDESIGN_PREF, true],
      [SHOWN_PREF, true],
    ],
  });

  let { win, tab } = await openTabAndWaitForRender();
  await SpecialPowers.spawn(tab, [], async function () {
    const intro = content.document.querySelector("private-browsing-mask-intro");
    ok(!intro.hidden, "The intro is still shown (final mask state)");
    ok(
      !intro.wrappedJSObject.play,
      "The intro does not play once already seen"
    );

    await intro.wrappedJSObject.updateComplete;
    const circle = intro.shadowRoot.querySelector(".circle");
    ok(
      !circle.classList.contains("playing"),
      "The circle is not in the playing state"
    );
  });

  await BrowserTestUtils.closeWindow(win);
  await SpecialPowers.popPrefEnv();
});

// Playing the intro persists the seen-once flag (via the RPMSetPref write path).
add_task(async function test_intro_persists_seen_flag() {
  Services.prefs.clearUserPref(SHOWN_PREF);
  await SpecialPowers.pushPrefEnv({
    set: [
      [REDESIGN_PREF, true],
      ["ui.prefersReducedMotion", 0],
    ],
  });

  let { win, tab } = await openTabAndWaitForRender();
  await SpecialPowers.spawn(tab, [], async function () {
    const intro = content.document.querySelector("private-browsing-mask-intro");
    ok(intro.wrappedJSObject.play, "The intro plays on the first run");
  });

  await TestUtils.waitForCondition(
    () => Services.prefs.getBoolPref(SHOWN_PREF, false),
    "The seen-once flag is persisted when the intro plays"
  );
  ok(
    Services.prefs.getBoolPref(SHOWN_PREF, false),
    "introAnimationShown is true after the intro plays"
  );

  await BrowserTestUtils.closeWindow(win);
  await SpecialPowers.popPrefEnv();
  Services.prefs.clearUserPref(SHOWN_PREF);
});

// Reduced motion: the intro is shown but does not animate.
add_task(async function test_intro_respects_reduced_motion() {
  await SpecialPowers.pushPrefEnv({
    set: [
      [REDESIGN_PREF, true],
      [SHOWN_PREF, false],
      ["ui.prefersReducedMotion", 1],
    ],
  });

  let { win, tab } = await openTabAndWaitForRender();
  await SpecialPowers.spawn(tab, [], async function () {
    const intro = content.document.querySelector("private-browsing-mask-intro");
    ok(!intro.hidden, "The intro is shown under reduced motion");
    ok(
      !intro.wrappedJSObject.play,
      "The intro does not play under reduced motion"
    );
  });

  await BrowserTestUtils.closeWindow(win);
  await SpecialPowers.popPrefEnv();
});
