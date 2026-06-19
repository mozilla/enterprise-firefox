/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef WINDOWS_UI_OVERLAY_IMAGE_H_
#define WINDOWS_UI_OVERLAY_IMAGE_H_

#include <cstdint>
#include <objbase.h>
#include <uiautomation.h>
#include <vector>
#include <windows.h>

#include "mozilla/RefPtr.h"
#include "nsISupportsImpl.h"
#include "nsWindowsHelpers.h"

namespace mozilla {

/**
 * Displays an overlay image on top of a UI Automation element.
 */
class WindowsUIOverlayImage final {
 public:
  enum class DisplayMode { Static, Animated };

  NS_INLINE_DECL_REFCOUNTING(WindowsUIOverlayImage)

  /**
   * Creates an overlay image for a given element.
   *
   * @param aWindow Window containing the element.
   * @param aElement UI Automation element.
   * @param aDisplayMode Display mode, which can be static or animated.
   * @return Overlay image.
   */
  static already_AddRefed<WindowsUIOverlayImage> Create(
      HWND aWindow, RefPtr<IUIAutomationElement> aElement,
      DisplayMode aDisplayMode);

  /**
   * Returns whether the overlay image is visible.
   *
   * @return true whether the overlay image is visible, false otherwise.
   */
  bool IsVisible();

  /**
   * Advances to the next frame of the image.
   */
  void AdvanceFrame();

  // Non-copyable and non-movable
  WindowsUIOverlayImage(const WindowsUIOverlayImage&) = delete;
  WindowsUIOverlayImage(WindowsUIOverlayImage&&) = delete;
  WindowsUIOverlayImage& operator=(const WindowsUIOverlayImage&) = delete;
  WindowsUIOverlayImage& operator=(WindowsUIOverlayImage&&) = delete;

 private:
  explicit WindowsUIOverlayImage(HWND aWindow,
                                 RefPtr<IUIAutomationElement> aElement,
                                 DisplayMode aDisplayMode);

  ~WindowsUIOverlayImage();

  bool Initialize();

  HWND mWindow;
  RefPtr<IUIAutomationElement> mElement;
  DisplayMode mDisplayMode;
  SIZE mSize;
  std::vector<std::vector<uint8_t>> mFrames;
  nsAutoBitmap mDib;
  nsAutoHDC mMemDC;
  void* mDibBits;
  HGDIOBJ mOldBmp;
  RECT mRect;
  HWND mOverlayWindow;
  size_t mCurrentFrame;
};

}  // namespace mozilla

#endif
