/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "AudioSink.h"
#include "AudioSinkWrapper.h"
#include "CubebUtils.h"
#include "MockCubeb.h"
#include "TimeUnits.h"
#include "gmock/gmock.h"
#include "gtest/gtest-printers.h"
#include "gtest/gtest.h"
#include "mozilla/SpinEventLoopUntil.h"
#include "mozilla/gtest/WaitFor.h"
#include "nsThreadManager.h"
#include "nsThreadUtils.h"

using namespace mozilla;

// This is a crashtest to check that AudioSinkWrapper::mEndedPromiseHolder is
// not settled twice when sync and async AudioSink initializations race.
TEST(TestAudioSinkWrapper, AsyncInitFailureWithSyncInitSuccess)
{
  MockCubeb* cubeb = new MockCubeb();
  CubebUtils::ForceSetCubebContext(cubeb->AsCubebContext());

  MediaQueue<AudioData> audioQueue;
  MediaInfo info;
  info.EnableAudio();
  auto audioSinkCreator = [&]() {
    return UniquePtr<AudioSink>{new AudioSink(AbstractThread::GetCurrent(),
                                              audioQueue, info.mAudio,
                                              /*resistFingerprinting*/ false)};
  };
  const double initialVolume = 0.0;  // so that there is initially no AudioSink
  RefPtr wrapper = new AudioSinkWrapper(
      AbstractThread::GetCurrent(), audioQueue, std::move(audioSinkCreator),
      initialVolume, /*playbackRate*/ 1.0, /*preservesPitch*/ true,
      /*sinkDevice*/ nullptr);

  wrapper->Start(media::TimeUnit::Zero(), info);
  // The first AudioSink init occurs on a background thread.  Listen for this,
  // but don't process any events on the current thread so that the
  // AudioSinkWrapper does not yet handle the result of AudioSink
  // initialization.
  RefPtr backgroundQueue =
      nsThreadManager::get().CreateBackgroundTaskQueue(__func__);
  Monitor monitor(__func__);
  bool initDone = false;
  MediaEventListener initListener = cubeb->StreamInitEvent().Connect(
      backgroundQueue, [&](RefPtr<SmartMockCubebStream> aStream) {
        EXPECT_EQ(aStream, nullptr);
        MonitorAutoLock lock(monitor);
        initDone = true;
        lock.Notify();
      });
  cubeb->ForceStreamInitError();
  wrapper->SetVolume(0.5);  // triggers async sink init, which fails
  {
    // Wait for the async init to complete.
    MonitorAutoLock lock(monitor);
    while (!initDone) {
      lock.Wait();
    }
  }
  initListener.Disconnect();
  wrapper->SetPlaying(false);
  // The second AudioSink init is synchronous.
  nsIThread* currentThread = NS_GetCurrentThread();
  RefPtr<SmartMockCubebStream> stream;
  initListener = cubeb->StreamInitEvent().Connect(
      currentThread, [&](RefPtr<SmartMockCubebStream> aStream) {
        stream = std::move(aStream);
      });
  wrapper->SetPlaying(true);  // sync sink init, which succeeds
  // Let AudioSinkWrapper handle the (first) AudioSink initialization failure
  // and allow `stream` to be set.
  NS_ProcessPendingEvents(currentThread);
  initListener.Disconnect();
  cubeb_state state = CUBEB_STATE_STARTED;
  MediaEventListener stateListener = stream->StateEvent().Connect(
      currentThread, [&](cubeb_state aState) { state = aState; });
  // Run AudioSinkWrapper::OnAudioEnded().
  // This test passes if there is no crash.  Bug 1845811.
  audioQueue.Finish();
  SpinEventLoopUntil("stream state change"_ns,
                     [&] { return state != CUBEB_STATE_STARTED; });
  stateListener.Disconnect();
  EXPECT_EQ(state, CUBEB_STATE_DRAINED);
  wrapper->Stop();
  wrapper->Shutdown();
}

// This is a crashtest to check that AudioSinkWrapper::mEndedPromiseHolder is
// not settled twice when the audio ends during async AudioSink initialization.
TEST(TestAudioSinkWrapper, AsyncInitWithEndOfAudio)
{
  MockCubeb* cubeb = new MockCubeb();
  CubebUtils::ForceSetCubebContext(cubeb->AsCubebContext());

  MediaQueue<AudioData> audioQueue;
  MediaInfo info;
  info.EnableAudio();
  auto audioSinkCreator = [&]() {
    return UniquePtr<AudioSink>{new AudioSink(AbstractThread::GetCurrent(),
                                              audioQueue, info.mAudio,
                                              /*resistFingerprinting*/ false)};
  };
  const double initialVolume = 0.0;  // so that there is initially no AudioSink
  RefPtr wrapper = new AudioSinkWrapper(
      AbstractThread::GetCurrent(), audioQueue, std::move(audioSinkCreator),
      initialVolume, /*playbackRate*/ 1.0, /*preservesPitch*/ true,
      /*sinkDevice*/ nullptr);

  wrapper->Start(media::TimeUnit::Zero(), info);
  // The first AudioSink init occurs on a background thread.  Listen for this,
  // but don't process any events on the current thread so that the
  // AudioSinkWrapper does not yet use the initialized AudioSink.
  RefPtr backgroundQueue =
      nsThreadManager::get().CreateBackgroundTaskQueue(__func__);
  Monitor monitor(__func__);
  RefPtr<SmartMockCubebStream> stream;
  MediaEventListener initListener = cubeb->StreamInitEvent().Connect(
      backgroundQueue, [&](RefPtr<SmartMockCubebStream> aStream) {
        EXPECT_NE(aStream, nullptr);
        MonitorAutoLock lock(monitor);
        stream = std::move(aStream);
        lock.Notify();
      });
  wrapper->SetVolume(0.5);  // triggers async sink init
  {
    // Wait for the async init to complete.
    MonitorAutoLock lock(monitor);
    while (!stream) {
      lock.Wait();
    }
  }
  initListener.Disconnect();
  // Finish the audio before AudioSinkWrapper considers using the initialized
  // AudioSink.
  audioQueue.Finish();
  // Wait for AudioSinkWrapper to destroy the initialized stream.
  // This test passes if there is no crash.  Bug 1846854.
  WaitFor(cubeb->StreamDestroyEvent());
  wrapper->Stop();
  wrapper->Shutdown();
}

// When playback has been advancing on the system clock while the audio stream
// (re)initializes (a seek resume or unmute), the switch to the audio clock must
// re-anchor to the system-clock position, not the audio stream's
// still-near-zero PLAYED position. Otherwise the reported position regresses by
// the cubeb output latency and the resume is observed about one position-update
// cycle late.
TEST(TestAudioSinkWrapper, ClockDoesNotRegressAtAudioStreamHandoff)
{
  MockCubeb* cubeb = new MockCubeb(MockCubeb::RunningMode::Manual);
  CubebUtils::ForceSetCubebContext(cubeb->AsCubebContext());

  MediaQueue<AudioData> audioQueue;
  MediaInfo info;
  info.EnableAudio();
  auto audioSinkCreator = [&]() {
    return UniquePtr<AudioSink>{new AudioSink(AbstractThread::GetCurrent(),
                                              audioQueue, info.mAudio,
                                              /*resistFingerprinting*/ false)};
  };
  // Start muted so there is initially no AudioSink and playback runs on the
  // system clock.
  RefPtr wrapper = new AudioSinkWrapper(
      AbstractThread::GetCurrent(), audioQueue, std::move(audioSinkCreator),
      /*initialVolume*/ 0.0, /*playbackRate*/ 1.0, /*preservesPitch*/ true,
      /*sinkDevice*/ nullptr);

  // Enough audio that the stream does not immediately drain.
  AlignedAudioBuffer samples(info.mAudio.mRate * info.mAudio.mChannels);
  RefPtr audio =
      new AudioData(/*aOffset*/ 0, media::TimeUnit::Zero(), std::move(samples),
                    info.mAudio.mChannels, info.mAudio.mRate);
  audioQueue.Push(audio);

  // Start() begins playback (sets the clock); the wrapper is muted, so there is
  // no AudioSink yet and playback runs on the system clock.
  wrapper->Start(media::TimeUnit::Zero(), info);
  // Sample once so the clock source latches to the system clock.
  wrapper->GetPosition();

  // Unmute: triggers asynchronous AudioSink init. With a manual MockCubeb the
  // data callback does not run until we drive it, so the stream's played
  // position stays at zero.
  auto initPromise = TakeN(cubeb->StreamInitEvent(), 1);
  wrapper->SetVolume(1.0);
  auto [stream] = WaitFor(initPromise).unwrap()[0];

  // Advance real time so the system clock moves clearly ahead of the
  // not-yet-played audio.
  const TimeDuration kAdvance = TimeDuration::FromMilliseconds(60);
  PR_Sleep(PR_MillisecondsToInterval(60));

  // Drive the audio callback once: the audio stream is now considered running,
  // but it has played almost nothing, so its played position is still near
  // zero.
  stream->ManualDataCallback(1);

  // The handoff to the audio clock must report the system-clock position, not
  // the audio's still-near-zero played position. The system clock advanced by
  // kAdvance (60 ms) while the stream played almost nothing, so a correct
  // handoff reports about 60 ms and the regression reports about 0 ms. The 0.04
  // s (40 ms) threshold sits well above the near-zero played position and well
  // below the 60 ms system clock, so it cleanly separates the two outcomes
  // while leaving margin for scheduling jitter in the sleep above.
  media::TimeUnit pos = wrapper->GetPosition();
  EXPECT_GE(pos.ToSeconds(), 0.04)
      << "clock regressed to the audio played position at the handoff (got "
      << pos.ToSeconds() << "s, expected to track the "
      << kAdvance.ToMilliseconds() << "ms system clock)";

  wrapper->Stop();
  wrapper->Shutdown();
}
