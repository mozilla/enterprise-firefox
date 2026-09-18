/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include <windows.h>

#include "mozilla/WidgetUtils.h"
#include "nsCOMPtr.h"
#include "nsIWidget.h"
#include "nsIWindowMediator.h"
#include "nsPIDOMWindow.h"
#include "nsServiceManagerUtils.h"

extern "C" {

// window.focus() only calls ::SetFocus, which cannot take the foreground from
// another process; the right granted by allow_browser_foreground() has to be
// spent with SetForegroundWindow.
void felt_activate_app() {
  nsCOMPtr<nsIWindowMediator> winMediator(
      do_GetService(NS_WINDOWMEDIATOR_CONTRACTID));
  if (!winMediator) {
    return;
  }
  nsCOMPtr<mozIDOMWindowProxy> navWin;
  winMediator->GetMostRecentBrowserWindow(getter_AddRefs(navWin));
  if (!navWin) {
    return;
  }
  nsCOMPtr<nsIWidget> widget = mozilla::widget::WidgetUtils::DOMWindowToWidget(
      nsPIDOMWindowOuter::From(navWin));
  if (!widget) {
    return;
  }
  ::SetForegroundWindow(
      static_cast<HWND>(widget->GetNativeData(NS_NATIVE_WINDOW)));
}

}  // extern "C"
