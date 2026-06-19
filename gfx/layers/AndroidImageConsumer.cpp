/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set ts=8 sts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "AndroidImageConsumer.h"

#include "GLContext.h"
#include "GLContextEGL.h"
#include "GLLibraryEGL.h"
#include "mozilla/layers/AndroidImageReader.h"
#include "mozilla/webrender/RenderThread.h"

namespace mozilla {
namespace layers {

/* static */
already_AddRefed<AndroidImageConsumer> AndroidImageConsumer::Create(
    AndroidImageReader* aImageReader, gl::GLContext* aGL) {
  MOZ_ASSERT(wr::RenderThread::IsInRenderThread());
  MOZ_ASSERT(aImageReader);
  MOZ_ASSERT(aGL);

  if (!XRE_IsGPUProcess() || !aImageReader || !aGL) {
    MOZ_ASSERT_UNREACHABLE("unexpected to be called");
    return nullptr;
  }

  GLuint tex;
  aGL->fGenTextures(1, &tex);

  RefPtr<AndroidImageConsumer> imageConsumer =
      new AndroidImageConsumer(aImageReader, aGL, tex);
  return imageConsumer.forget();
}

AndroidImageConsumer::AndroidImageConsumer(AndroidImageReader* aImageReader,
                                           gl::GLContext* aGL,
                                           const GLuint aTextureHandle)
    : mImageReaderId(aImageReader->mImageReaderId),
      mGL(aGL),
      mTextureHandle(aTextureHandle),
      mImageReader(aImageReader) {
  MOZ_ASSERT(mImageReader);
  MOZ_ASSERT(mGL);
}

AndroidImageConsumer::~AndroidImageConsumer() {
  MOZ_ASSERT(wr::RenderThread::IsInRenderThread());

  auto* imageReaderMap = layers::GpuProcessAndroidImageReaderMap::Get();
  if (imageReaderMap) {
    imageReaderMap->UnregisterImageConsumer(mImageReaderId);
  }

  mGL->fDeleteTextures(1, &mTextureHandle);
}

void AndroidImageConsumer::UpdateTexImage(
    const AndroidMediaCodecFrameId aFrameId) {
  MOZ_ASSERT(wr::RenderThread::IsInRenderThread());

  if (!mImageReader->UpdateTexImage(aFrameId)) {
    return;
  }

  RefPtr<AndroidImageWrapper> image = mImageReader->GetCurrentImage();
  if (!image) {
    MOZ_ASSERT_UNREACHABLE("unexpected to be called");
    return;
  }

  // XXX add fence handling

  const auto& gle = gl::GLContextEGL::Cast(mGL);
  const auto& egl = gle->mEgl;

  const EGLint attrs[] = {
      LOCAL_EGL_IMAGE_PRESERVED,
      LOCAL_EGL_TRUE,
      LOCAL_EGL_NONE,
  };

  auto* nativeBuffer = image->mHardwareBuffer;

  EGLClientBuffer clientBuffer =
      egl->mLib->fGetNativeClientBufferANDROID(nativeBuffer);
  EGLImage eglImage = egl->fCreateImage(
      EGL_NO_CONTEXT, LOCAL_EGL_NATIVE_BUFFER_ANDROID, clientBuffer, attrs);

  MOZ_ASSERT(eglImage);

  if (eglImage) {
    mGL->fBindTexture(LOCAL_GL_TEXTURE_EXTERNAL, mTextureHandle);
    mGL->fTexParameteri(LOCAL_GL_TEXTURE_EXTERNAL, LOCAL_GL_TEXTURE_WRAP_T,
                        LOCAL_GL_CLAMP_TO_EDGE);
    mGL->fTexParameteri(LOCAL_GL_TEXTURE_EXTERNAL, LOCAL_GL_TEXTURE_WRAP_S,
                        LOCAL_GL_CLAMP_TO_EDGE);
    mGL->fEGLImageTargetTexture2D(LOCAL_GL_TEXTURE_EXTERNAL, eglImage);
    egl->fDestroyImage(eglImage);
  }

  mCurrentImage = image;
}

gfx::SurfaceFormat AndroidImageConsumer::GetFormat() {
  if (!mCurrentImage) {
    return gfx::SurfaceFormat::UNKNOWN;
  }
  return mCurrentImage->mFormat;
}

gfx::IntSize AndroidImageConsumer::GetSize() {
  if (!mCurrentImage) {
    return gfx::IntSize();
  }
  return mCurrentImage->mSize;
}

}  // namespace layers
}  // namespace mozilla
