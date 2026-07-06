/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

window.MozXULElement?.insertFTLIfNeeded("locales-preview/theme-picker.ftl");

import { html, styleMap } from "../vendor/lit.all.mjs";
import { MozLitElement } from "../lit-utils.mjs";

// Placeholder theme list bug 2051554 / bug 2050529.
const FIREFOX_THEMES_LIST = [
  {
    id: "default-theme@mozilla.org",
    isBuiltIn: true,
    themePickerColors: {
      light: {
        type: "gradient",
        value: "linear-gradient(96deg, #EADDFF 39.84%, #FFDBC5 101.72%)",
      },
      dark: {
        type: "gradient",
        value: "linear-gradient(96deg, #3E315F 39.84%, #701c07 101.72%)",
      },
    },
  },
  {
    id: "nova-sun@mozilla.org",
    themePickerColors: {
      light: {
        type: "gradient",
        value: "linear-gradient(90deg, #F9F5E6 0%, #FDE8B5 60%, #FBCC77 100%)",
      },
      dark: {
        type: "gradient",
        value: "linear-gradient(90deg, #5F3100 0%, #3E1D00 60%, #270F00 100%)",
      },
    },
  },
  {
    id: "nova-spark@mozilla.org",
    themePickerColors: {
      light: {
        type: "gradient",
        value: "linear-gradient(135deg, #F8F0EC 0%, #FFDBC5 60%, #FEBD99 100%)",
      },
      dark: {
        type: "gradient",
        value: "linear-gradient(135deg, #701C07 0%, #461209 60%, #250E0B 100%)",
      },
    },
  },
  {
    id: "nova-flame@mozilla.org",
    themePickerColors: {
      light: {
        type: "gradient",
        value: "linear-gradient(135deg, #FCF2F3 0%, #FFD9DF 60%, #FFB6BF 100%)",
      },
      dark: {
        type: "gradient",
        value: "linear-gradient(135deg, #69172D 0%, #42121F 60%, #211014 100%)",
      },
    },
  },
  {
    id: "nova-flare@mozilla.org",
    themePickerColors: {
      light: {
        type: "gradient",
        value: "linear-gradient(135deg, #F7EFF3 0%, #FFD5EE 60%, #FFB0E2 100%)",
      },
      dark: {
        type: "gradient",
        value: "linear-gradient(135deg, #5F1854 0%, #3C1334 60%, #1E111B 100%)",
      },
    },
  },
  {
    id: "nova-lavender@mozilla.org",
    themePickerColors: {
      light: {
        type: "gradient",
        value: "linear-gradient(135deg, #FAEBFF 0%, #F6D7FF 60%, #E8B7FF 100%)",
      },
      dark: {
        type: "gradient",
        value: "linear-gradient(135deg, #4F216B 0%, #311842 60%, #1A1220 100%)",
      },
    },
  },
  {
    id: "nova-dusk@mozilla.org",
    themePickerColors: {
      light: {
        type: "gradient",
        value: "linear-gradient(135deg, #F5ECFF 0%, #EADDFF 60%, #D4C1FF 100%)",
      },
      dark: {
        type: "gradient",
        value: "linear-gradient(135deg, #3E2976 0%, #271C48 60%, #161423 100%)",
      },
    },
  },
  {
    id: "nova-lagoon@mozilla.org",
    themePickerColors: {
      light: {
        type: "gradient",
        value: "linear-gradient(135deg, #ECF3F8 0%, #C5EAFE 60%, #A2D3FF 100%)",
      },
      dark: {
        type: "gradient",
        value: "linear-gradient(135deg, #23327B 0%, #17214C 60%, #111524 100%)",
      },
    },
  },
  {
    id: "nova-pine@mozilla.org",
    themePickerColors: {
      light: {
        type: "gradient",
        value: "linear-gradient(135deg, #ECF4F1 0%, #C4F1E0 60%, #90E3C6 100%)",
      },
      dark: {
        type: "gradient",
        value: "linear-gradient(135deg, #004933 0%, #003020 60%, #001E12 100%)",
      },
    },
  },
  {
    id: "nova-tide@mozilla.org",
    themePickerColors: {
      light: {
        type: "gradient",
        value: "linear-gradient(135deg, #EBF4F5 0%, #C3EEF8 60%, #8FDDF0 100%)",
      },
      dark: {
        type: "gradient",
        value: "linear-gradient(135deg, #034554 0%, #002D38 60%, #011C23 100%)",
      },
    },
  },
  {
    id: "nova-ash@mozilla.org",
    themePickerColors: {
      light: {
        type: "gradient",
        value: "linear-gradient(90deg, #FCFBFF 0%, #EFEDF2 60%, #D6D5DA 100%)",
      },
      dark: {
        type: "gradient",
        value: "linear-gradient(90deg, #3F3E42 0%, #252428 60%, #171519 100%)",
      },
    },
  },
  {
    id: "nova-smoke@mozilla.org",
    themePickerColors: {
      light: {
        type: "gradient",
        value: "linear-gradient(135deg, #FFF9F6 0%, #FBF4EE 60%, #E3DBD7 100%)",
      },
      dark: {
        type: "gradient",
        value: "linear-gradient(135deg, #3B3532 0%, #2F2926 60%, #201B18 100%)",
      },
    },
  },
];

/**
 * @import { ReactiveController } from "chrome://global/content/vendor/lit.all.mjs";
 */

const DEFAULT_THEME_ID = "default-theme@mozilla.org";

/**
 * @typedef {object} ThemePickerTheme
 * @property {string} id
 * @property {{ light: { type: string, value: string }, dark: { type: string, value: string } }} themePickerColors
 */

/**
 * @typedef {"appearance"|"theme"|"nativeTheme"} ThemechangeProperty
 * @typedef {{ property: ThemechangeProperty, value: string|boolean }} ThemechangeEventDetail
 */

/**
 * @typedef {CustomEvent & { detail: ThemechangeEventDetail }} ThemechangeEvent
 */

/**
 * @implements {ReactiveController}
 */
class ThemePickerStorybookController {
  /**
   * @param {ThemePicker} host
   */
  constructor(host) {
    this.host = host;
    this.host.addController(this);
    this.host.addEventListener(
      "themechange",
      /** @param {{ detail: ThemechangeEventDetail }} e */
      e => {
        switch (e.detail.property) {
          case "appearance":
            this.host.appearance = String(e.detail.value);
            break;
          case "theme":
            this.host.activeThemeId = String(e.detail.value);
            break;
          case "nativeTheme":
            this.host.nativeTheme = Boolean(e.detail.value);
            break;
        }
      }
    );
  }

  hostConnected() {
    this.host.themes = FIREFOX_THEMES_LIST;
    this.host.activeThemeId = DEFAULT_THEME_ID;
    this.host.appearance = "device";
    this.host.nativeTheme = false;
  }
}

/**
 * Component description goes here.
 *
 * @tagname theme-picker
 * @property {string} variant - Property description goes here
 */
export default class ThemePicker extends MozLitElement {
  static properties = {
    appearance: { type: String },
    activeThemeId: { type: String },
    nativeTheme: { type: Boolean },
    themes: { type: Array },
  };

  constructor() {
    super();
    this.appearance = "device";
    this.activeThemeId = DEFAULT_THEME_ID;
    /** @type {ThemePickerTheme[]} */
    this.themes = [];
    this.nativeTheme = false;
    this.controller = new ThemePickerStorybookController(this);
  }

  /**
   * @param {ThemechangeProperty} property
   * @param {string|boolean} value
   */
  dispatchChange(property, value) {
    this.dispatchEvent(
      new CustomEvent("themechange", {
        bubbles: true,
        composed: true,
        detail: { property, value },
      })
    );
  }

  /**
   * @param {Event & { target: { value: string } }} e
   */
  appearanceChange(e) {
    this.dispatchChange("appearance", e.target.value);
  }

  /**
   * @param {Event & { target: { value: string } }} e
   */
  themeChange(e) {
    this.dispatchChange("theme", e.target.value);
  }

  /**
   * @param {Event & { target: { checked: boolean } }} e
   */
  nativeThemeChange(e) {
    this.dispatchChange("nativeTheme", e.target.checked);
  }

  /**
   * @param {ThemePickerTheme} theme
   */
  themeStyle(theme) {
    let colors =
      this.appearance == "dark"
        ? theme.themePickerColors.dark
        : theme.themePickerColors.light;
    return styleMap({
      backgroundImage: colors.value,
    });
  }

  render() {
    const icons = {
      // eslint-disable-next-line mozilla/no-browser-refs-in-toolkit
      light: "chrome://browser/skin/weather/sunny.svg",
      // eslint-disable-next-line mozilla/no-browser-refs-in-toolkit
      dark: "chrome://browser/skin/weather/night-clear.svg",
      // eslint-disable-next-line mozilla/no-browser-refs-in-toolkit
      device: "chrome://browser/skin/device-desktop.svg",
    };
    return html`
      <link
        rel="stylesheet"
        href="chrome://global/content/elements/theme-picker.css"
      />
      <moz-segmented-control
        .value=${this.appearance}
        @change=${this.appearanceChange}
      >
        <moz-segmented-control-item
          data-l10n-id="theme-picker-mode-light"
          value="light"
          .iconSrc=${icons.light}
        ></moz-segmented-control-item>
        <moz-segmented-control-item
          data-l10n-id="theme-picker-mode-dark"
          value="dark"
          .iconSrc=${icons.dark}
        ></moz-segmented-control-item>
        <moz-segmented-control-item
          data-l10n-id="theme-picker-mode-device"
          value="device"
          .iconSrc=${icons.device}
        ></moz-segmented-control-item>
      </moz-segmented-control>
      <moz-visual-picker
        .value=${this.activeThemeId}
        @change=${this.themeChange}
      >
        ${this.themes.map(
          theme =>
            html`<moz-visual-picker-item value=${theme.id}
              ><div class="theme-preview" style=${this.themeStyle(theme)}></div
            ></moz-visual-picker-item>`
        )}
      </moz-visual-picker>
      <moz-checkbox
        data-l10n-id="theme-picker-use-linux-theme"
        ?checked=${this.nativeTheme}
        ?disabled=${this.activeThemeId != DEFAULT_THEME_ID}
        @change=${this.nativeThemeChange}
      ></moz-checkbox>
    `;
  }
}
customElements.define("theme-picker", ThemePicker);
