/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include <windows.h>

#include "mozilla/WidgetUtils.h"
#include "nsCOMPtr.h"
#include "nsDebug.h"
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
    NS_WARNING("felt_activate_app: no window mediator");
    return;
  }
  nsCOMPtr<mozIDOMWindowProxy> navWin;
  winMediator->GetMostRecentBrowserWindow(getter_AddRefs(navWin));
  if (!navWin) {
    NS_WARNING("felt_activate_app: no browser window to activate");
    return;
  }
  nsCOMPtr<nsIWidget> widget = mozilla::widget::WidgetUtils::DOMWindowToWidget(
      nsPIDOMWindowOuter::From(navWin));
  if (!widget) {
    NS_WARNING("felt_activate_app: browser window has no widget");
    return;
  }
  if (!::SetForegroundWindow(
          static_cast<HWND>(widget->GetNativeData(NS_NATIVE_WINDOW)))) {
    NS_WARNING("felt_activate_app: SetForegroundWindow failed");
  }
}

}  // extern "C"
