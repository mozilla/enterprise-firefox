/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  createEnterpriseLogger:
    "resource://gre/modules/enterprise/EnterpriseCommon.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  return lazy.createEnterpriseLogger("FeltBrowserDOMWindow");
});

// Carry the opener's principal to apply the load checks the original open
// would have gotten, in the target browser's origin attributes.
function triggeringPrincipalFor(browser, openerPrincipal) {
  const originAttributes = browser.browsingContext.originAttributes;
  if (openerPrincipal?.isContentPrincipal) {
    return Services.scriptSecurityManager.principalWithOA(
      openerPrincipal,
      originAttributes
    );
  }
  return Services.scriptSecurityManager.createNullPrincipal(originAttributes);
}

export const FeltWindowOpenPane = {
  isShowing(doc) {
    return !doc
      .querySelector(".felt-login__window-open")
      .classList.contains("is-hidden");
  },

  show(doc, uri, openerPrincipal) {
    doc.querySelector(".felt-login__window-open").classList.remove("is-hidden");
    const browser = doc.getElementById("window-open-browser");
    browser.fixupAndLoadURIString(uri.spec, {
      triggeringPrincipal: triggeringPrincipalFor(browser, openerPrincipal),
    });
    browser.focus();
  },

  close(doc) {
    doc.querySelector(".felt-login__window-open").classList.add("is-hidden");
    const browser = doc.getElementById("window-open-browser");
    browser.fixupAndLoadURIString("about:blank", {
      triggeringPrincipal: triggeringPrincipalFor(browser),
    });
    doc.getElementById("browser").focus();
  },
};

/**
 * Prevents content window.open() calls in the Felt UI window from opening a
 * browser.xhtml window, and tries to show the URL in the window.open pane instead.
 */
export class FeltBrowserDOMWindow {
  QueryInterface = ChromeUtils.generateQI(["nsIBrowserDOMWindow"]);

  /**
   * @param {Window} win The Felt UI window.
   */
  static install(win) {
    win.browserDOMWindow = new FeltBrowserDOMWindow(win);
    // 0 routes window.open() with features through nsIBrowserDOMWindow.
    Services.prefs
      .getDefaultBranch("")
      .setIntPref("browser.link.open_newwindow.restriction", 0);
  }

  constructor(win) {
    this._win = win;
  }

  _tryShowInPane(aURI, aOpenerPrincipal) {
    if (aURI) {
      try {
        FeltWindowOpenPane.show(this._win.document, aURI, aOpenerPrincipal);
        lazy.log.debug(`Showed a window.open target in the pane: ${aURI.spec}`);
      } catch (e) {
        lazy.log.error("Failed to show a window.open target in the pane", e);
      }
    }
    // Throw to abort the open
    throw Components.Exception(
      "Opening browser windows is not allowed in the Felt UI",
      Cr.NS_ERROR_NOT_AVAILABLE
    );
  }

  createContentWindow(aURI, aOpenWindowInfo, aWhere, aFlags, aPrincipal) {
    return this._tryShowInPane(aURI, aPrincipal);
  }

  createContentWindowInFrame(aURI, aParams) {
    return this._tryShowInPane(aURI, aParams?.triggeringPrincipal);
  }

  openURI(aURI, aOpenWindowInfo, aWhere, aFlags, aPrincipal) {
    return this._tryShowInPane(aURI, aPrincipal);
  }

  openURIInFrame(aURI, aParams) {
    return this._tryShowInPane(aURI, aParams?.triggeringPrincipal);
  }

  canClose() {
    return true;
  }

  get tabCount() {
    return 1;
  }
}
