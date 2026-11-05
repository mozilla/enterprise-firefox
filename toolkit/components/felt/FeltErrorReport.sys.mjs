/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  createEnterpriseLogger:
    "moz-src:///toolkit/components/enterprise/modules/EnterpriseCommon.sys.mjs",
  getResolvedErrorConfig: "chrome://global/content/errors/error-lookup.mjs",
  initializeRegistry: "chrome://global/content/errors/error-registry.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  return lazy.createEnterpriseLogger("FeltErrorReport");
});

export const ERROR_SOURCE = {
  XHR: "xhr",
  NET: "net",
  RESET: "reset",
};

export const FeltErrorReport = {
  _wrapper: null,

  /* Per UX requirements, there are some error messages where it is required
   * there is more control over on enterprise builds: it can be because the
   * way information is displayed is not as efficient as the original
   * about:neterror page and string needs rewording, incorrect casing,
   * duplicated error messages that may refers to UI elements that do not
   * exists, etc.
   */
  _errorCodesMapping: {
    dnsNotFound: "dnsNotFound-enterprise",
    netOffline: "NS_ERROR_OFFLINE",
  },

  /* Show simpler "No Network Connection" only for truly offline scenarios:
   *  - netOffline for offline mode,
   *  - dnsNotFound for actual network disconnect
   */
  _noNetworkErrors: ["netOffline", "dnsNotFound"],

  /**
   * Gets the error fluent id for a channel status code.
   *
   * @param {number} status - The channel status code
   * @returns {string} Fluent ID
   */
  getFluentIdForStatus(status) {
    lazy.log.debug(`getFluentIdForStatus(${status})`);
    try {
      const nssErrorsService = Cc[
        "@mozilla.org/nss_errors_service;1"
      ].getService(Ci.nsINSSErrorsService);
      return nssErrorsService.getErrorName(status);
    } catch {
      lazy.log.debug(
        `getFluentIdForStatus(${status}) no nssErrorsService.getErrorName`
      );
      // Not an NSS error, check common network error codes

      // Mapping here should follow what nsDocShell::DisplayLoadError uses.
      const networkErrors = {
        [Cr.NS_ERROR_UNKNOWN_HOST]: "dnsNotFound",
        [Cr.NS_ERROR_CONNECTION_REFUSED]: "connectionFailure",
        [Cr.NS_ERROR_NET_TIMEOUT]: "netTimeout",
        [Cr.NS_ERROR_NET_RESET]: "netReset",
        [Cr.NS_ERROR_NET_INTERRUPT]: "netInterrupt",
        [Cr.NS_ERROR_OFFLINE]: "netOffline",
      };
      lazy.log.debug(
        `getFluentIdForStatus(${status}) networkErrors[status]:${networkErrors[status]}`
      );
      return networkErrors[status] ?? "network";
    }
  },

  init(doc) {
    this._document = doc;
    lazy.initializeRegistry();
    this._wrapper = this._document.querySelector(".felt-browser-error");
    this._wrapper.addEventListener("message-bar:user-dismissed", e => {
      e.preventDefault();
      e.target.classList.add("is-hidden");
    });
  },

  reset() {
    if (!this._wrapper) {
      return;
    }
    for (const bar of this._wrapper.querySelectorAll("moz-message-bar")) {
      bar.classList.add("is-hidden");
    }
  },

  async _maybeResetErrorElement(errorElement) {
    lazy.log.debug(`_maybeResetErrorElement()`);
    errorElement.dismiss();
    errorElement.removeAttribute("source");

    errorElement
      .querySelectorAll(".felt-browser-error-details[added]")
      .forEach(el => el.remove());

    // Remove so next l10n.setAttributes() will re-translate from original HTML
    errorElement.removeAttribute("heading");
    if (errorElement.dataset.l10nId) {
      this._document.l10n.setAttributes(
        errorElement,
        errorElement.dataset.l10nId
      );
      await this._document.l10n.translateElements([errorElement]);
    }

    return errorElement;
  },

  /**
   * Leverages existing about:certerror/about:neterror string IDs and error
   * handling to update the error message displayed to the user
   *
   * @param {object} errorElement - The HTML element holding the error message
   * @param {string} errorCode - The specific error code used for displaying the error message.
   * @param {object} context - Additional context for the error.
   * @param {string} context.hostname - The hostname related to the error.
   * @param {boolean} context.canUseCustomNetError - Indicates if a custom network error can be used.
   * @param {object} detailsElement - The HTML element holding the error message details, if used.
   */
  async _applyErrorConfig(
    errorElement,
    errorCode,
    context,
    detailsElement = null
  ) {
    lazy.log.debug(`_applyErrorConfig(${errorCode})`);

    try {
      const errorConfig = lazy.getResolvedErrorConfig(errorCode, context);
      if (errorConfig.introContent) {
        lazy.log.debug(`_applyErrorConfig(${errorCode}): resolved errorConfig`);
        this._document.l10n.setAttributes(
          detailsElement,
          errorConfig.introContent.dataL10nId,
          errorConfig.introContent.dataL10nArgs
        );
      }
      if (errorConfig.customNetError && context.canUseCustomNetError) {
        lazy.log.debug(
          `_applyErrorConfig(${errorCode}): errorConfig.customNetError`
        );
        errorElement.setAttribute(
          "heading",
          await this._document.l10n.formatValue(
            errorConfig.customNetError.titleL10nId
          )
        );
        if (errorConfig.customNetError.whatCanYouDoL10nId) {
          this._document.l10n.setAttributes(
            detailsElement,
            errorConfig.customNetError.whatCanYouDoL10nId,
            errorConfig.customNetError.whatCanYouDoL10nArgs
          );
        } else if (errorConfig.customNetError.whatCanYouDoItems) {
          errorConfig.customNetError.whatCanYouDoItems.forEach(itemL10nId => {
            const itemElement = this._document.createElement("span");
            itemElement.slot = "message";
            itemElement.className = "felt-browser-error-details";
            itemElement.setAttribute("added", "true");
            this._document.l10n.setAttributes(itemElement, itemL10nId);
            errorElement.appendChild(itemElement);
          });
        }
      }
    } catch (ex) {
      lazy.log.debug(
        `_applyErrorConfig(${errorCode}) not resolved: ${ex} -- Falling back`
      );
    }
  },

  /**
   * Updates the error display based on the error type and details.
   *
   * @param {string} errorType - The type of error to display.
   * @param {string|null} errorCode - The specific error code used for displaying the error message.
   * @param {object|null} context - Additional context for the error.
   * @param {string} source - The source of the error, from ERROR_SOURCE
   */
  async update(errorType, errorCode = null, context = null, source = null) {
    lazy.log.debug(`update(${errorType}, ${errorCode})`);

    const errorElement = this._wrapper.querySelector(`.${errorType}`);
    if (!errorElement) {
      lazy.log.error(`Error element ${errorType} not found`);
      return;
    }

    await this._maybeResetErrorElement(errorElement);

    if (errorCode) {
      const detailsElement = errorElement.querySelector(
        ".felt-browser-error-details"
      );
      if (detailsElement) {
        if (context) {
          await this._applyErrorConfig(
            errorElement,
            errorCode,
            context,
            detailsElement
          );
        }

        const l10n = this._document.l10n.getAttributes(detailsElement);
        if (!l10n?.id) {
          lazy.log.debug(
            `update(${errorType}): this._applyErrorConfig missing, fallback to felt-error-${errorCode}`
          );
          const message = await this._document.l10n.formatValue(
            `felt-error-${errorCode}`
          );
          detailsElement.textContent = message || errorCode;
        }
      }
    }

    if (source) {
      errorElement.setAttribute("source", source);
    }

    errorElement.classList.remove("is-hidden");
  },

  /**
   * Handle displaying an error produced by about:neterror/about:certerror
   * sent from FeltErrorWindowChild.
   *
   * @param {object} aData - The message containing the error URL in 'errorPageURI'
   *                         field which is a URL containing error code as 'e'
   *                         parameter and URL triggering the error as
   *                         'u' parameter.
   */
  async handleNetError(aData) {
    const errorPageURI = aData.errorPageURI;
    lazy.log.debug(`handleNetError(${errorPageURI})`);

    try {
      const parsedErrorPage = new URL(errorPageURI);
      const errorCode = (() => {
        const parsedErrorCode = parsedErrorPage.searchParams.get("e");
        const mappedErrorCode = this._errorCodesMapping[parsedErrorCode];
        if (mappedErrorCode) {
          lazy.log.debug(
            `handleNetError(${errorPageURI}): mapping ${parsedErrorCode} to ${mappedErrorCode}`
          );
          return mappedErrorCode;
        }
        lazy.log.debug(
          `handleNetError(${errorPageURI}): returning ${parsedErrorCode}`
        );
        return parsedErrorCode;
      })();

      const errorHostname = new URL(parsedErrorPage.searchParams.get("u")).host;

      await this.updateNetworkError(
        errorCode,
        {
          hostname: errorHostname,
          canUseCustomNetError: true,
        },
        ERROR_SOURCE.NET
      );
    } catch (ex) {
      lazy.log.debug(
        `handleNetError: exception ${ex}, reverting to default network error`
      );
      await this.updateNetworkError("network", null, ERROR_SOURCE.NET);
    }

    this._document
      .querySelector(".felt-login__email-pane")
      .classList.remove("is-hidden");
    this._document.querySelector(".felt-login__sso").classList.add("is-hidden");
  },

  /**
   * Handle displaying an error produced by XmlHttpRequest.
   *
   * @param {object} aError - The TypeError containing the XHR channel status
   *                          code in aError.cause.channelStatus and the
   *                          hostname of the URL triggering the error in
   *                          aError.cause.hostname.
   */
  async handleXhrError(aError) {
    lazy.log.debug(
      `handleXhrError(aError.message=${aError.message} aError.cause=${JSON.stringify(aError.cause)})`
    );
    if (aError.cause) {
      const errorCode = this.getFluentIdForStatus(aError.cause.channelStatus);
      lazy.log.debug(
        `handleXhrError() using errorCode:${errorCode} for ${aError.cause.channelStatus}`
      );
      await this.updateNetworkError(errorCode, aError.cause, ERROR_SOURCE.XHR);
    } else {
      lazy.log.debug(`handleXhrError: received ${aError} without a cause`);
      await this.updateNetworkError("network", null, ERROR_SOURCE.XHR);
    }
  },

  /**
   * Handle displaying a network error generated from about: or XHR.
   * Error codes are filtered to display either the error connection or the
   * no network display.
   *
   * @param {string} errorCode - The error code as a string value
   * @param {object} context - The error context, with hostname field holding the
   *                         value of the host triggering the error
   * @param {string} source - The source of the error, ERROR_SOURCE.XHR or
   *                          ERROR_SOURCE.NET. Useful for assertions in tests.
   */
  async updateNetworkError(errorCode, context, source) {
    lazy.log.debug(`updateNetworkError(${errorCode})`);

    if (this._noNetworkErrors.includes(errorCode)) {
      await this.update(
        "felt-browser-error-no-network",
        "no-network-connection",
        null,
        source
      );
    } else {
      await this.update(
        "felt-browser-error-connection",
        errorCode,
        context,
        source
      );
    }
  },
};
