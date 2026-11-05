/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  BrowserUtils: "resource://gre/modules/BrowserUtils.sys.mjs",
  ConsoleClient:
    "moz-src:///toolkit/components/enterprise/modules/ConsoleClient.sys.mjs",
  isTesting:
    "moz-src:///toolkit/components/enterprise/modules/EnterpriseCommon.sys.mjs",
  createEnterpriseLogger:
    "moz-src:///toolkit/components/enterprise/modules/EnterpriseCommon.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  return lazy.createEnterpriseLogger("EnterpriseBadge");
});

const COMPANY_LOGO_URL_PREF = "enterprise.configs.company_logo_url";
const LEARN_MORE_URL_PREF = "enterprise.configs.learn_more_url";

/**
 * Parses a given url string
 *
 * @param {string} url url string from preference
 * @returns {URL|null} A parsed `URL` object if it's valid, otherwise `null`.
 */
function parseUrl(url) {
  try {
    return new URL(url);
  } catch {
    lazy.log.error(`Invalid URL: ${url}`);
    return null;
  }
}

/**
 * Validate that the URL is HTTPS.
 *
 * @param {string} url - The URL string to validate.
 * @returns {URL|null} A parsed `URL` object if validation succeeds, otherwise `null`.
 */
function validateHttpsUrl(url) {
  const parsedUrl = parseUrl(url);

  if (!parsedUrl) {
    return null;
  }

  const isLocalTest =
    lazy.isTesting() &&
    (parsedUrl.hostname === "localhost" || parsedUrl.hostname === "127.0.0.1");

  if (parsedUrl.protocol !== "https:" && !isLocalTest) {
    lazy.log.warn(`Expected HTTPS URL: ${url}`);
    return null;
  }

  return parsedUrl;
}

/**
 * Validates that a URL string is a base64-encoded data URL for a supported image type.
 *
 * Supported MIME types are PNG, JPEG, GIF, WebP, and SVG.
 *
 * If validation fails, an error is logged and `null` is returned.
 *
 * @param {string} url - The URL string to validate.
 * @returns {URL|null} A parsed `URL` object if validation succeeds, otherwise `null`.
 */
function validateDataUrl(url) {
  const parsedUrl = parseUrl(url);

  if (!parsedUrl) {
    return null;
  }

  const isSupportedImageDataUrl =
    parsedUrl.protocol === "data:" &&
    /^image\/(?:png|jpeg|gif|webp|svg\+xml);base64,/.test(parsedUrl.pathname);

  if (!isSupportedImageDataUrl) {
    lazy.log.error(
      `Expected a base64-encoded supported image data URL: ${url}`
    );
    return null;
  }
  return parsedUrl;
}

/**
 * Produce a data URL from an non data URL to hold the user picture
 *
 * @param {string} url - The URL to fetch the picture from
 * @returns {Promise} Promise that performs the data URL conversion
 */
async function urlToDataUrl(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  const blob = await response.blob();

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result); // "data:image/png;base64,...."
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export const EnterpriseBadge = {
  /**
   * @type {{name:string, email:string, pictureUrl:string} | null}
   */
  _signedInUser: null,

  /**
   * Whether the handler is initialized, meaning the user information
   * from the signed in user has been received from the console.
   */
  _isInitialized: false,

  /**
   * Initializes the enterprise badge: Fetches the information of the signed-in
   * user and populates the badge with the user information.
   *
   * @param {Window} window chrome window
   */
  async init(window) {
    if (Services.felt.isFeltUI()) {
      // Nothing to setup for the felt window
      return;
    }
    if (!this._isInitialized) {
      lazy.log.debug("Initializing...");
      this._isInitialized = true;
      await this.initUser();
    }
    this.updateBadge(window);
  },

  async initUser() {
    try {
      const { name, email, picture } =
        await lazy.ConsoleClient.getLoggedInUserInfo();
      let pictureUrl = null;
      if (picture) {
        try {
          pictureUrl =
            validateDataUrl(await urlToDataUrl(picture))?.href ?? null;
        } catch (e) {
          lazy.log.warn("Unable to fetch user picture: ", e);
        }
      }
      this._signedInUser = { name, email, pictureUrl };
    } catch (e) {
      // TODO: Bug 2000864 - Handle unsuccessful GET /WHOAMI
      lazy.log.warn("Unable to initialize enterprise user: ", e);
    }
  },

  /**
   * Updates the user icon and badge logo
   *
   * @param {Window} window chrome window
   */
  updateBadge(window) {
    this._updateLogo(window);
    this._updateUserIcon(window);
  },

  /**
   * Updates the user icon in the enterprise badge
   *
   * If the signed-in user information is available:
   * - Uses the user's picture url (provided by the IdP) when available.
   * - Falls back to displaying user initials when no picture url is provided.
   * - Finally falls back to generic avatar icon if neither picture nor name available.
   *
   * Hides the user icon if no user information is currently available.
   *
   * @param {Window} window - The chrome window containing the enterprise UI elements.
   * @returns {void}
   */
  _updateUserIcon(window) {
    if (!this._signedInUser) {
      // No user information available so user icon remains hidden
      lazy.log.warn(
        "Unable to update user icon in badge without user information"
      );
      return;
    }

    const wrapper = window.document.getElementById(
      "enterprise-user-icon__wrapper"
    );
    const { name, pictureUrl } = this._signedInUser;
    if (pictureUrl) {
      const userIcon = window.document.querySelector(
        "#enterprise-user-icon__picture"
      );
      userIcon.style.setProperty("list-style-image", `url("${pictureUrl}")`);
      wrapper.dataset.userIconType = "picture";
    } else if (name) {
      // Fallback to user initials
      const initials = name.trim().charAt(0).toLocaleUpperCase();
      const initialsDiv = window.document.getElementById(
        "enterprise-user-icon__initials"
      );
      initialsDiv.textContent = initials;
      wrapper.dataset.userIconType = "initials";
    } else {
      wrapper.dataset.userIconType = "avatar";
    }
    wrapper.classList.remove("is-hidden");
  },

  /**
   * Retrieves and validates the learn more URL.
   * Returns null if the url is invalid.
   */
  _retrieveLearnMoreLink() {
    const learnMoreUrl = Services.prefs.getStringPref(LEARN_MORE_URL_PREF, "");

    if (!learnMoreUrl) {
      lazy.log.warn("No learn more url available.");
      return null;
    }

    return validateHttpsUrl(learnMoreUrl);
  },

  /**
   * Retrieves, validates, and applies the learn more URL to the link element.
   * Use fallback of "https://support.mozilla.org/kb/managed-browser-firefox" is no valid URL provided.
   *
   * @param {Window} win - chrome window
   * @returns {void}
   */
  _setupLearnMoreLink(win) {
    const validLearnMoreUrl =
      this._retrieveLearnMoreLink() ??
      parseUrl("https://support.mozilla.org/kb/managed-browser-firefox");

    const document = win.document;
    const viewNode = win.PanelMultiView.getViewNode(
      document,
      "panelUI-enterprise"
    );
    const learnMoreLink = viewNode.querySelector("#enterprise-learn-more-link");
    lazy.log.debug(`Setting learn more uri to ${validLearnMoreUrl.href}`);
    learnMoreLink.setAttribute("href", validLearnMoreUrl.href);

    learnMoreLink.addEventListener("click", e => {
      let where = lazy.BrowserUtils.whereToOpenLink(e, false, false);
      if (where == "current") {
        where = "tab";
      }
      win.openTrustedLinkIn(validLearnMoreUrl.href, where);
      e.preventDefault();

      const panel = viewNode.closest("panel");
      win.PanelMultiView.hidePopup(panel);
    });
  },

  openPanel(element, event) {
    const win = element.documentGlobal;
    win.PanelUI.showSubView("panelUI-enterprise", element, event);
    const document = element.ownerDocument;
    const viewNode = win.PanelMultiView.getViewNode(
      document,
      "panelUI-enterprise"
    );

    if (!element._isEnterpriseLearnMoreLinkConfigured) {
      this._setupLearnMoreLink(win);
      element._isEnterpriseLearnMoreLinkConfigured = true;
    }

    const email = viewNode.querySelector(".panelUI-enterprise__email");
    if (!this._signedInUser) {
      email.hidden = true;
      viewNode.querySelector("#PanelUI-enterprise-email-separator").hidden =
        true;
      lazy.log.warn(
        "Unable to update email in enterprise panel without user information"
      );
      return;
    }

    if (!email.textContent) {
      email.textContent = this._signedInUser.email;
    }
  },

  uninit() {
    this._signedInUser = null;
    this._isInitialized = false;
  },

  _updateLogo(window) {
    const logoUrl = Services.prefs.getStringPref(COMPANY_LOGO_URL_PREF, "");

    if (!logoUrl) {
      lazy.log.warn(
        `Unable to retrieve company logo url from: ${COMPANY_LOGO_URL_PREF}`
      );
      return;
    }

    const validLogoUrl = validateDataUrl(logoUrl);

    if (validLogoUrl !== null) {
      const toolbarLogoWrapper = window.document.querySelector(
        "#enterprise-company-logo__wrapper"
      );
      const toolbarLogo = toolbarLogoWrapper.querySelector("image");
      toolbarLogo.style.setProperty(
        "list-style-image",
        `url("${validLogoUrl.href}")`
      );
      toolbarLogoWrapper.classList.remove("is-hidden");
    }
  },
};
