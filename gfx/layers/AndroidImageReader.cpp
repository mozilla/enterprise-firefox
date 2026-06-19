/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set ts=8 sts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "AndroidImageReader.h"

#include <android/hardware_buffer.h>
#include <media/NdkImage.h>
#include <media/NdkImageReader.h>

#include "mozilla/gfx/2D.h"
#include "mozilla/gfx/Logging.h"
#include "mozilla/layers/AndroidImageConsumer.h"
#include "mozilla/TimeStamp.h"
#include "mozilla/webrender/RenderThread.h"
#include "nsProxyRelease.h"

namespace mozilla {
namespace layers {

AndroidImageReaderImage::AndroidImageReaderImage(
    const GpuProcessAndroidImageReaderId aImageReaderId,
    const gfx::IntSize& aSize, const bool aHasAlpha)
    : Image(nullptr, ImageFormat::ANDROID_IMAGE_READER),
      mImageReaderId(aImageReaderId),
      mFrameId(AndroidMediaCodecFrameId::GetNext()),
      mSize(aSize),
      mHasAlpha(aHasAlpha) {
  MOZ_ASSERT(XRE_IsGPUProcess());
}

AndroidImageReaderImage::~AndroidImageReaderImage() {
  auto* imageReaderMap = layers::GpuProcessAndroidImageReaderMap::Get();
  if (imageReaderMap) {
    imageReaderMap->MaybeReleaseFrameToCodec(mImageReaderId, mFrameId,
                                             /* aRender */ false);
  }
}

Maybe<SurfaceDescriptor> AndroidImageReaderImage::GetDesc() {
  return Nothing();
}

void AndroidImageReaderImage::OnSetCurrent() {}

bool AndroidImageReaderImage::MaybeReleaseFrameToCodec(bool aRender) {
  if (!mSetCurrentCallback) {
    return false;
  }

  bool ret = (*mSetCurrentCallback)(aRender);
  mSetCurrentCallback.reset();
  return ret;
}

AndroidImageWrapper::AndroidImageWrapper(AndroidImageReader* aImageReader,
                                         AImage* aImage,
                                         AHardwareBuffer* aHardwareBuffer,
                                         const gfx::IntSize aSize,
                                         const gfx::SurfaceFormat aFormat,
                                         mozilla::UniqueFileHandle&& aFence)
    : mHardwareBuffer(aHardwareBuffer),
      mSize(aSize),
      mFormat(aFormat),
      mImageReader(aImageReader),
      mImage(aImage),
      mFence(std::move(aFence)) {}

AndroidImageWrapper::~AndroidImageWrapper() {
  AImage_delete(mImage);
  // XXX Add fence handling
  // AImage_deleteAsync(mImage fence);
}

mozilla::UniqueFileHandle AndroidImageWrapper::CloneFence() {
  auto fence = ipc::FileDescriptor(GetHandle());
  return fence.TakePlatformHandle();
}

/* static */
already_AddRefed<AndroidImageReader> AndroidImageReader::Create() {
  if (!XRE_IsGPUProcess()) {
    MOZ_ASSERT_UNREACHABLE("unexpected to be called");
    return nullptr;
  }

  auto* imageReaderMap = layers::GpuProcessAndroidImageReaderMap::Get();
  if (!imageReaderMap) {
    return nullptr;
  }

  RefPtr<AndroidImageReader> imageReader = new AndroidImageReader();
  bool ret = imageReader->Init();
  if (!ret) {
    return nullptr;
  }

  imageReaderMap->Register(imageReader);

  return imageReader.forget();
}

AndroidImageReader::AndroidImageReader()
    : mImageReaderId(GpuProcessAndroidImageReaderId::GetNext()),
      mMonitor("mozilla.layers.AndroidImageReader.mMonitor") {}

AndroidImageReader::~AndroidImageReader() {
  auto* imageReaderMap = layers::GpuProcessAndroidImageReaderMap::Get();
  if (imageReaderMap) {
    imageReaderMap->Unregister(mImageReaderId);
  }
  ReleaseResources();
}

bool AndroidImageReader::Init() {
  MonitorAutoLock lock(mMonitor);

  MOZ_ASSERT(!mInited);

  // Set the width, height and format to some default value. This parameters
  // are/maybe overriden by the producer sending buffers to this imageReader's
  // Surface.
  const int32_t width = 1, height = 1;
  // AndroidImageConsumer::UpdateTexImage() requests at least 2 concurrently
  // acquired AImages.
  const uint32_t maxImageCount = 2;
  uint64_t usage = AHARDWAREBUFFER_USAGE_GPU_SAMPLED_IMAGE;

  // XXX set if video could be used for overlay.
  // usage |= AHARDWAREBUFFER_USAGE_COMPOSER_OVERLAY;

  media_status_t result;
  AImageReader* reader = nullptr;
  result = AImageReader_newWithUsage(width, height, AIMAGE_FORMAT_PRIVATE,
                                     usage, maxImageCount, &reader);
  if (result != AMEDIA_OK) {
    gfxCriticalNoteOnce << "AImageReader_newWithUsage failed"
                        << static_cast<int32_t>(result);
    return false;
  }

  mAImageReader = reader;

  ANativeWindow* window = nullptr;
  result = AImageReader_getWindow(reader, &window);
  if (result != AMEDIA_OK) {
    gfxCriticalNoteOnce << "AImageReader_getWindow failed"
                        << static_cast<int32_t>(result);
    return false;
  }
  mNativeWindow = window;

  auto listener = std::make_unique<AImageReader_ImageListener>();
  listener->context = reinterpret_cast<void*>(this);
  listener->onImageAvailable = &AndroidImageReader::OnFrameAvailable;

  result = AImageReader_setImageListener(reader, listener.get());
  if (result != AMEDIA_OK) {
    gfxCriticalNoteOnce << "setImageListener failed"
                        << static_cast<int32_t>(result);
    return false;
  }

  MOZ_ASSERT(mAImageReader);
  MOZ_ASSERT(mNativeWindow);
  mInited = true;

  return true;
}

void AndroidImageReader::ReleaseResources() {
  MonitorAutoLock lock(mMonitor);

  if (!mAImageReader) {
    return;
  }

  AImageReader_setImageListener(mAImageReader, nullptr);

  // Delete all images before closing the associated image reader.

  // Delete the image reader.
  AImageReader_delete(mAImageReader);
  mAImageReader = nullptr;
  // mNativeWindow is not owned by AndroidImageReader.
  // It is owned by AImageReader.
  mNativeWindow = nullptr;
}

/* static */
void AndroidImageReader::OnFrameAvailable(void* aContext,
                                          AImageReader* aReader) {
  auto* reader = static_cast<AndroidImageReader*>(aContext);

  reader->NotifyFrameAvailable();
}

void AndroidImageReader::NotifyFrameAvailable() {
  MonitorAutoLock lock(mMonitor);
  mWaitingFrameAvailable = false;
  mMonitor.Notify();
}

bool AndroidImageReader::UpdateTexImage(
    const AndroidMediaCodecFrameId aFrameId) {
  MonitorAutoLock lock(mMonitor);

  if (mCurrentFrameId == aFrameId) {
    return false;
  }

  MOZ_ASSERT(!mWaitingFrameAvailable);
  mWaitingFrameAvailable = true;

  if (!MaybeReleaseFrameToCodec(lock, aFrameId, /* aRender */ true)) {
    mWaitingFrameAvailable = false;
    return false;
  }

  const TimeDuration timeout = TimeDuration::FromMilliseconds(10000);

  while (mWaitingFrameAvailable) {
    CVStatus status = mMonitor.Wait(timeout);
    if (status == CVStatus::Timeout) {
      gfxCriticalNoteOnce << "UpdateTexImage wait timeout";
      return false;
    }
  }

  mWaitingFrameAvailable = false;

  AImage* image = nullptr;
  media_status_t ret = AMEDIA_OK;
  UniqueFileHandle fence;
  ret = AImageReader_acquireNextImageAsync(mAImageReader, &image,
                                           getter_Transfers(fence));
  // XXX Add AImageReader_acquireLatestImageAsync() usage

  switch (ret) {
    case AMEDIA_ERROR_INVALID_PARAMETER:
      MOZ_ASSERT_UNREACHABLE("unexpected to be called");
      return false;
    case AMEDIA_IMGREADER_MAX_IMAGES_ACQUIRED:
      MOZ_ASSERT_UNREACHABLE("unexpected to be called");
      return false;
    case AMEDIA_IMGREADER_NO_BUFFER_AVAILABLE:
      return false;
    case AMEDIA_ERROR_UNKNOWN:
      return false;
    case AMEDIA_OK:
      // Call succeeded.
      break;
    default:
      MOZ_ASSERT_UNREACHABLE("unexpected to be called");
      return false;
  }

  if (!image) {
    return false;
  }

  AHardwareBuffer* nativeBuffer = nullptr;
  media_status_t result = AImage_getHardwareBuffer(image, &nativeBuffer);
  if (!nativeBuffer) {
    gfxCriticalNoteOnce << "AImage_getHardwareBuffer failed"
                        << static_cast<int32_t>(result);
    return false;
  }

  AHardwareBuffer_Desc bufferInfo = {};
  AHardwareBuffer_describe(nativeBuffer, &bufferInfo);

  const gfx::IntSize size = gfx::IntSize(bufferInfo.width, bufferInfo.height);
  // XXX
  const gfx::SurfaceFormat format = gfx::SurfaceFormat::R8G8B8A8;

  // XXX add crop handling

  mCurrentImage = new AndroidImageWrapper(this, image, nativeBuffer, size,
                                          format, std::move(fence));
  return true;
}

ANativeWindow* AndroidImageReader::GetANativeWindow() {
  MonitorAutoLock lock(mMonitor);
  return mNativeWindow;
}

RefPtr<AndroidImageWrapper> AndroidImageReader::GetCurrentImage() {
  MonitorAutoLock lock(mMonitor);
  return mCurrentImage;
}

void AndroidImageReader::RegisterReaderImage(
    AndroidImageReaderImage* aReaderImage) {
  if (!aReaderImage) {
    MOZ_ASSERT_UNREACHABLE("unexpected to be called");
    return;
  }
  MonitorAutoLock lock(mMonitor);

  MOZ_ASSERT(mPendingFrames.find(aReaderImage->mFrameId) ==
             mPendingFrames.end());
  mPendingFrames.emplace(aReaderImage->mFrameId, aReaderImage);
}

bool AndroidImageReader::MaybeReleaseFrameToCodec(
    const AndroidMediaCodecFrameId aFrameId, const bool aRender) {
  MonitorAutoLock lock(mMonitor);
  return MaybeReleaseFrameToCodec(lock, aFrameId, aRender);
}
bool AndroidImageReader::MaybeReleaseFrameToCodec(
    const MonitorAutoLock& aProofOfLock,
    const AndroidMediaCodecFrameId aFrameId, const bool aRender) {
  auto it = mPendingFrames.find(aFrameId);
  if (it == mPendingFrames.end()) {
    return false;
  }

  bool ret = it->second->MaybeReleaseFrameToCodec(aRender);
  mPendingFrames.erase(it);

  return ret;
}

StaticAutoPtr<GpuProcessAndroidImageReaderMap>
    GpuProcessAndroidImageReaderMap::sInstance;

/* static */
void GpuProcessAndroidImageReaderMap::Init() {
  MOZ_ASSERT(XRE_IsGPUProcess());

  sInstance = new GpuProcessAndroidImageReaderMap();
}

/* static */
void GpuProcessAndroidImageReaderMap::Shutdown() { sInstance = nullptr; }

GpuProcessAndroidImageReaderMap::GpuProcessAndroidImageReaderMap()
    : mMonitor("GpuProcessAndroidImageReaderMap.mMonitor") {}

void GpuProcessAndroidImageReaderMap::Register(
    AndroidImageReader* aImageReader) {
  MOZ_ASSERT(aImageReader);

  if (!aImageReader) {
    MOZ_ASSERT_UNREACHABLE("unexpected to be called");
    return;
  }

  MonitorAutoLock lock(mMonitor);

  auto it = mImageReaders.find(aImageReader->mImageReaderId);
  if (it != mImageReaders.end()) {
    MOZ_ASSERT_UNREACHABLE("unexpected to be called");
    return;
  }

  mImageReaders.emplace(aImageReader->mImageReaderId,
                        MakeUnique<ImageReaderHolder>(aImageReader));
}

void GpuProcessAndroidImageReaderMap::Unregister(
    GpuProcessAndroidImageReaderId aImageReaderId) {
  MonitorAutoLock lock(mMonitor);

  const auto it = mImageReaders.find(aImageReaderId);
  MOZ_ASSERT(it != mImageReaders.end());
  if (it == mImageReaders.end()) {
    MOZ_ASSERT_UNREACHABLE("unexpected to be called");
    return;
  }
  mImageReaders.erase(it);
}

RefPtr<AndroidImageReader> GpuProcessAndroidImageReaderMap::GetImageReader(
    GpuProcessAndroidImageReaderId aImageReaderId) {
  MonitorAutoLock lock(mMonitor);

  const auto it = mImageReaders.find(aImageReaderId);
  if (it == mImageReaders.end()) {
    return nullptr;
  }
  return it->second->mImageReader;
}

bool GpuProcessAndroidImageReaderMap::MaybeReleaseFrameToCodec(
    const GpuProcessAndroidImageReaderId aImageReaderId,
    const AndroidMediaCodecFrameId aFrameId, const bool aRender) {
  RefPtr<AndroidImageReader> reader = GetImageReader(aImageReaderId);
  if (!reader) {
    return false;
  }
  return reader->MaybeReleaseFrameToCodec(aFrameId, aRender);
}

RefPtr<AndroidImageConsumer> GpuProcessAndroidImageReaderMap::GetImageConsumer(
    const GpuProcessAndroidImageReaderId aImageReaderId, gl::GLContext* aGL) {
  MOZ_ASSERT(wr::RenderThread::IsInRenderThread());
  MOZ_ASSERT(aGL);

  MonitorAutoLock lock(mMonitor);

  const auto it = mImageReaders.find(aImageReaderId);
  if (it == mImageReaders.end()) {
    return nullptr;
  }

  auto* holder = it->second.get();

  if (holder->mImageConsumer) {
    if (holder->mImageConsumer->mGL == aGL) {
      return holder->mImageConsumer;
    }
    MOZ_ASSERT_UNREACHABLE("unexpected to be called");
    return nullptr;
  }

  RefPtr<AndroidImageConsumer> imageConsumer;
  imageConsumer = AndroidImageConsumer::Create(holder->mImageReader, aGL);
  if (!imageConsumer) {
    MOZ_ASSERT_UNREACHABLE("unexpected to be called");
    return nullptr;
  }

  holder->mImageConsumer = imageConsumer;

  return imageConsumer;
}

void GpuProcessAndroidImageReaderMap::UnregisterImageConsumer(
    GpuProcessAndroidImageReaderId aImageReaderId) {
  MOZ_ASSERT(wr::RenderThread::IsInRenderThread());

  MonitorAutoLock lock(mMonitor);

  const auto it = mImageReaders.find(aImageReaderId);
  if (it == mImageReaders.end()) {
    return;
  }

  auto* holder = it->second.get();

  MOZ_ASSERT(holder->mImageConsumer);
  holder->mImageConsumer = nullptr;
}

GpuProcessAndroidImageReaderMap::ImageReaderHolder::ImageReaderHolder(
    AndroidImageReader* aImageReader)
    : mImageReader(aImageReader) {}

GpuProcessAndroidImageReaderMap::ImageReaderHolder::~ImageReaderHolder() {}

}  // namespace layers
}  // namespace mozilla
