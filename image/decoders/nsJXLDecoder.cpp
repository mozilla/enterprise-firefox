/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*-
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "ImageLogging.h"  // Must appear first

#include "nsJXLDecoder.h"

#include "mozilla/CheckedInt.h"
#include "RasterImage.h"
#include "SurfacePipeFactory.h"
#include "mozilla/Vector.h"

using namespace mozilla::gfx;

namespace mozilla::image {

static LazyLogModule sJXLLog("JXLDecoder");

nsJXLDecoder::nsJXLDecoder(RasterImage* aImage)
    : Decoder(aImage),
      mLexer(Transition::ToUnbuffered(State::FINISHED_JXL_DATA, State::JXL_DATA,
                                      SIZE_MAX),
             Transition::TerminateSuccess()) {
  MOZ_LOG(sJXLLog, LogLevel::Debug,
          ("[this=%p] nsJXLDecoder::nsJXLDecoder", this));
}

nsresult nsJXLDecoder::InitInternal() {
  mDecoder.reset(jxl_decoder_new(IsMetadataDecode()));
  return NS_OK;
}

nsJXLDecoder::~nsJXLDecoder() {
  MOZ_LOG(sJXLLog, LogLevel::Debug,
          ("[this=%p] nsJXLDecoder::~nsJXLDecoder", this));
}

LexerResult nsJXLDecoder::DoDecode(SourceBufferIterator& aIterator,
                                   IResumable* aOnResume) {
  MOZ_ASSERT(!HasError(), "Shouldn't call DoDecode after error!");

  return mLexer.Lex(aIterator, aOnResume,
                    [this](State aState, const char* aData, size_t aLength) {
                      switch (aState) {
                        case State::JXL_DATA:
                          return ReadJXLData(aData, aLength);
                        case State::FINISHED_JXL_DATA:
                          return FinishedJXLData();
                      }
                      MOZ_CRASH("Unknown State");
                    });
}

LexerTransition<nsJXLDecoder::State> nsJXLDecoder::ReadJXLData(
    const char* aData, size_t aLength) {
  MOZ_ASSERT(mDecoder);

  const uint8_t* currentData = reinterpret_cast<const uint8_t*>(aData);
  size_t currentLength = aLength;

  while (true) {
    uint8_t* bufferPtr = mPixelBuffer.empty() ? nullptr : mPixelBuffer.begin();
    size_t bufferLen = mPixelBuffer.length();

    JxlDecoderStatus status = jxl_decoder_process_data(
        mDecoder.get(), &currentData, &currentLength, bufferPtr, bufferLen);

    switch (status) {
      case JxlDecoderStatus::Ok: {
        if (!HasSize()) {
          JxlBasicInfo basicInfo = jxl_decoder_get_basic_info(mDecoder.get());
          if (!basicInfo.valid) {
            if (currentLength == 0) {
              return Transition::ContinueUnbuffered(State::JXL_DATA);
            } else {
              break;
            }
          }

          if (basicInfo.width > INT32_MAX || basicInfo.height > INT32_MAX) {
            return Transition::TerminateFailure();
          }

          PostSize(basicInfo.width, basicInfo.height);
          if (basicInfo.has_alpha) {
            PostHasTransparency();
          }
          PostFrameCount(1);  // Static JXL = 1 frame

          if (IsMetadataDecode()) {
            return Transition::TerminateSuccess();
          }
        }

        bool frameReady = jxl_decoder_is_frame_ready(mDecoder.get());

        // Check if frame is ready for rendering and we need to allocate buffer
        if (HasSize() && frameReady && mPixelBuffer.empty()) {
          OrientedIntSize size = Size();
          CheckedInt<size_t> bufferSize =
              CheckedInt<size_t>(size.width) * size.height * 4;
          if (!bufferSize.isValid()) {
            MOZ_LOG(sJXLLog, LogLevel::Error,
                    ("[this=%p] nsJXLDecoder::ReadJXLData -- buffer size "
                     "overflow\n",
                     this));
            return Transition::TerminateFailure();
          }
          if (!mPixelBuffer.resize(bufferSize.value())) {
            MOZ_LOG(sJXLLog, LogLevel::Error,
                    ("[this=%p] nsJXLDecoder::ReadJXLData -- failed to "
                     "allocate pixel buffer\n",
                     this));
            return Transition::TerminateFailure();
          }
          break;
        }

        // Frame rendering complete when frameReady becomes false
        if (HasSize() && !frameReady && !mPixelBuffer.empty()) {
          // The pixel buffer has been filled by jxl_decoder_process_data.
          // Send it through the surface pipeline and finish decoding.
          nsresult rv = ProcessFrame(mPixelBuffer);
          if (NS_FAILED(rv)) {
            return Transition::TerminateFailure();
          }

          PostDecodeDone();
          return Transition::TerminateSuccess();
        } else if (currentLength == 0) {
          return Transition::ContinueUnbuffered(State::JXL_DATA);
        }
        break;
      }

      case JxlDecoderStatus::NeedMoreData: {
        if (currentLength == 0) {
          return Transition::ContinueUnbuffered(State::JXL_DATA);
        }
        break;
      }

      case JxlDecoderStatus::Error:
        return Transition::TerminateFailure();
    }
  }
}

LexerTransition<nsJXLDecoder::State> nsJXLDecoder::FinishedJXLData() {
  MOZ_ASSERT_UNREACHABLE("Read the entire address space?");
  return Transition::TerminateFailure();
}

nsresult nsJXLDecoder::ProcessFrame(Vector<uint8_t>& aPixelBuffer) {
  MOZ_ASSERT(HasSize());
  MOZ_ASSERT(mDecoder);

  JxlBasicInfo basicInfo = jxl_decoder_get_basic_info(mDecoder.get());

  OrientedIntSize size = Size();
  SurfaceFormat inFormat = SurfaceFormat::R8G8B8A8;
  SurfaceFormat outFormat =
      basicInfo.has_alpha ? SurfaceFormat::OS_RGBA : SurfaceFormat::OS_RGBX;
  SurfacePipeFlags pipeFlags = SurfacePipeFlags();

  Maybe<SurfacePipe> pipe = SurfacePipeFactory::CreateSurfacePipe(
      this, size, OutputSize(), FullFrame(), inFormat, outFormat, Nothing(),
      nullptr, pipeFlags);
  if (!pipe) {
    return NS_ERROR_FAILURE;
  }

  uint8_t* currentRow = aPixelBuffer.begin();
  for (int32_t y = 0; y < size.height; ++y) {
    WriteState result =
        pipe->WriteBuffer(reinterpret_cast<uint32_t*>(currentRow));
    if (result == WriteState::FAILURE) {
      return NS_ERROR_FAILURE;
    }
    currentRow += size.width * 4;
  }

  if (Maybe<SurfaceInvalidRect> invalidRect = pipe->TakeInvalidRect()) {
    PostInvalidation(invalidRect->mInputSpaceRect,
                     Some(invalidRect->mOutputSpaceRect));
  }

  PostFrameStop(basicInfo.has_alpha ? Opacity::SOME_TRANSPARENCY
                                    : Opacity::FULLY_OPAQUE);
  return NS_OK;
}

}  // namespace mozilla::image
