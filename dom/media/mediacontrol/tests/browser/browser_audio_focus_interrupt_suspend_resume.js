/**
 * End-to-end audio-focus interruption driven through the chrome
 * MediaController: pausing with a system reason suspends a tab's audible Web
 * Audio and Web Speech, and resuming revives them. A page that explicitly
 * suspends its own AudioContext while interrupted keeps ownership of the
 * suspended state, so a later interruption end does not auto-resume it.
 */
"use strict";

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["dom.audio_session.enabled", true],
      ["media.audioFocus.webaudio.enabled", true],
      ["media.mediacontrol.testingevents.enabled", true],
      ["media.webspeech.synth.test", true],
    ],
  });
});

const WEB_AUDIO_URL = GetTestWebBasedURL("file_web_audio.html");
const WEB_SPEECH_URL = GetTestWebBasedURL("file_web_speech.html");

// A system audio-focus interruption suspends running Web Audio, and a resume
// brings it back.
add_task(async function test_web_audio_interrupt_suspend_resume() {
  const tab = await createLoadedTabWrapper(WEB_AUDIO_URL, { needCheck: false });
  const browser = tab.linkedBrowser;
  const controller = browser.browsingContext.mediaController;

  await startWebAudio(browser);
  is(await audioContextState(browser), "running", "Web Audio is running");

  info("system-transient interruption should suspend Web Audio");
  controller.pause("system-transient");
  await waitForAudioContextState(browser, "suspended");

  info("resume should revive the suspended Web Audio");
  controller.resume();
  await waitForAudioContextState(browser, "running");

  await tab.close();
});

// If the page suspends its own AudioContext while interrupted, it has taken
// over the suspended state; a later interruption end must not auto-resume it.
add_task(async function test_page_suspend_during_interrupt_is_not_resumed() {
  const tab = await createLoadedTabWrapper(WEB_AUDIO_URL, { needCheck: false });
  const browser = tab.linkedBrowser;
  const controller = browser.browsingContext.mediaController;

  await startWebAudio(browser);
  controller.pause("system-transient");
  await waitForAudioContextState(browser, "suspended");

  info("page explicitly suspends its AudioContext while interrupted");
  await SpecialPowers.spawn(browser, [], async () => {
    await content.ac.suspend();
  });

  info("a resume must leave the page-owned suspend untouched");
  controller.resume();
  // Once the page has suspended, the context stays suspended until the page
  // itself resumes, so this state is stable: a read returns "suspended" whether
  // or not the resume interrupt has been delivered yet. No polling needed.
  is(
    await audioContextState(browser),
    "suspended",
    "page-owned suspend is not auto-resumed"
  );

  info("only the page can resume its own AudioContext");
  await SpecialPowers.spawn(browser, [], async () => {
    await content.ac.resume();
  });
  is(await audioContextState(browser), "running", "page resume still works");

  await tab.close();
});

// A system audio-focus interruption pauses speaking Web Speech, and a resume
// revives it.
add_task(async function test_web_speech_interrupt_suspend_resume() {
  const tab = await createLoadedTabWrapper(WEB_SPEECH_URL, {
    needCheck: false,
  });
  const browser = tab.linkedBrowser;
  const controller = browser.browsingContext.mediaController;

  await SpecialPowers.spawn(browser, [], async () => {
    content.document.getElementById("start").click();
    await content.wrappedJSObject.waitForSpeechStart();
  });

  info("system-transient interruption should pause speech");
  controller.pause("system-transient");
  await SpecialPowers.spawn(browser, [], async () => {
    await content.wrappedJSObject.waitForSpeechPause();
  });
  ok(true, "speech paused on interruption");

  info("resume should revive the paused speech");
  controller.resume();
  await SpecialPowers.spawn(browser, [], async () => {
    await content.wrappedJSObject.waitForSpeechResume();
  });
  ok(true, "speech resumed on interruption end");

  await SpecialPowers.spawn(browser, [], () => {
    content.wrappedJSObject.cancelSpeech();
  });
  await tab.close();
});

// Note: there is no Web Speech analogue of
// test_page_suspend_during_interrupt_is_not_resumed. SpeechSynthesis.pause()
// is a no-op while the utterance is already paused (SpeechSynthesis.cpp), so a
// page cannot take over an interruption-pause the way it can take over an
// AudioContext suspend; an interruption end therefore resumes the speech.
// Giving Web Speech that parity is left to bug 2047321.

// below are helper functions.

function startWebAudio(browser) {
  return SpecialPowers.spawn(browser, [], async () => {
    content.ac = new content.AudioContext();
    const osc = content.ac.createOscillator();
    osc.connect(content.ac.destination);
    osc.start();
    if (content.ac.state !== "running") {
      await content.ac.resume();
    }
  });
}

function audioContextState(browser) {
  return SpecialPowers.spawn(browser, [], () => content.ac.state);
}

function waitForAudioContextState(browser, expected) {
  return SpecialPowers.spawn(browser, [expected], async expected => {
    const ac = content.ac;
    if (ac.state === expected) {
      return;
    }
    await new Promise(resolve => {
      ac.addEventListener("statechange", function listener() {
        if (ac.state === expected) {
          ac.removeEventListener("statechange", listener);
          resolve();
        }
      });
    });
  });
}
