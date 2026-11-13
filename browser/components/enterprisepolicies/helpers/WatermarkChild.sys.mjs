/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * Content-process side of the Watermark policy. When the document matches one
 * of the configured matches, this draws a tiled, diagonal watermark over the
 * page using Document.insertAnonymousContent(), which inserts the markup into
 * the document's canvasFrame anonymous content, on top of the page but
 * inaccessible to it.
 */

/**
 * @typedef {import("./WatermarkPolicy.sys.mjs").WatermarkConfig} WatermarkConfig
 */

const PREF_LOGLEVEL = "browser.policies.loglevel";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ReaderMode: "moz-src:///toolkit/components/reader/ReaderMode.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  let { ConsoleAPI } = ChromeUtils.importESModule(
    "resource://gre/modules/Console.sys.mjs"
  );
  return new ConsoleAPI({
    prefix: "WatermarkPolicy",
    maxLogLevel: "error",
    maxLogLevelPref: PREF_LOGLEVEL,
  });
});

/**
 * Substitutes the "%t" (timestamp) and "%e" (email) placeholders in `copy`.
 *
 * @param {string} copy Watermark text, possibly containing placeholders.
 * @param {WatermarkConfig} config Watermark configuration providing `timestamp` and `email`.
 * @returns {string}
 */
function templateWatermarkText(copy, config) {
  if (!copy) {
    return "";
  }
  return copy
    .replaceAll("%t", config.timestamp ?? "")
    .replaceAll("%e", config.email ?? "");
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Builds an inline SVG element that tiles the (optionally two-line) rotated
 * watermark text across its whole area.
 * The watermark is drawn as in-document SVG (a tiled `<pattern>`). The element
 * fills its positioned parent through absolute insets set via the CSSOM.
 *
 * @param {Document} doc
 * @param {WatermarkConfig} config Watermark configuration.
 * @param {string} patternId Document-unique id for the tiling `<pattern>`.
 * @returns {SVGElement}
 */
function watermarkSvg(doc, config, patternId) {
  let size = config.size;
  let fontSize = config.fontSize;
  let rowGap = fontSize * 0.5;
  let copy = templateWatermarkText(config.copy, config);
  let secondRowText = templateWatermarkText(config.secondaryCopy, config);

  let svg = doc.createElementNS(SVG_NS, "svg");
  svg.style.cssText =
    "position: absolute !important; inset: 0 !important; width: 100%; height: 100%;";

  let pattern = doc.createElementNS(SVG_NS, "pattern");
  pattern.setAttribute("id", patternId);
  pattern.setAttribute("width", size);
  pattern.setAttribute("height", size);
  pattern.setAttribute("patternUnits", "userSpaceOnUse");

  let group = doc.createElementNS(SVG_NS, "g");
  group.setAttribute(
    "transform",
    `rotate(${config.angle} ${size / 2} ${size / 2})`
  );

  let addText = (text, y, textFontSize) => {
    let node = doc.createElementNS(SVG_NS, "text");
    node.setAttribute("x", size / 2);
    node.setAttribute("y", y);
    node.setAttribute("fill", config.color);
    node.setAttribute("stroke", `contrast-color(${config.color})`);
    node.setAttribute("stroke-width", "0.5");
    node.setAttribute("font-family", "sans-serif");
    node.setAttribute("text-anchor", "middle");
    node.setAttribute("dominant-baseline", "middle");
    node.setAttribute("font-size", textFontSize);
    node.textContent = text;
    group.appendChild(node);
  };

  // Centered on its own when there's no second row, otherwise shifted up to
  // make room for it below.
  addText(copy, secondRowText ? size / 2 - rowGap : size / 2, fontSize);
  if (secondRowText) {
    addText(secondRowText, size / 2 + rowGap, fontSize * 0.7);
  }

  pattern.appendChild(group);
  let defs = doc.createElementNS(SVG_NS, "defs");
  defs.appendChild(pattern);
  svg.appendChild(defs);

  let rect = doc.createElementNS(SVG_NS, "rect");
  rect.setAttribute("width", "100%");
  rect.setAttribute("height", "100%");
  rect.setAttribute("fill", `url(#${patternId})`);
  svg.appendChild(rect);

  return svg;
}

/**
 * Returns the height, in pixels, that the watermark should cover to fill
 * the visible viewport as well as any content that overflows it.
 *
 * @param {Document} doc
 * @returns {number}
 */
function documentHeight(doc) {
  return Math.max(
    doc.defaultView?.innerHeight ?? 0,
    doc.documentElement?.scrollHeight ?? 0,
    doc.body?.scrollHeight ?? 0
  );
}

/**
 * Returns the width, in pixels, that the watermark should cover to fill
 * the visible viewport as well as any content that overflows it.
 *
 * @param {Document} doc
 * @returns {number}
 */
function documentWidth(doc) {
  return Math.max(
    doc.defaultView?.innerWidth ?? 0,
    doc.documentElement?.scrollWidth ?? 0,
    doc.body?.scrollWidth ?? 0
  );
}

/**
 *
 * @returns {Array<string>}
 */
function watermarkCommonStyle() {
  return ["pointer-events: none !important", "z-index: 2147483647 !important"];
}

/**
 * CSS declarations for the on-screen watermark node. For anonymous content,
 * 100% is in regard to the viewport, so the height has to be set explicitly
 * to also cover content that overflows it.
 *
 * @param {number} width Width in pixels, from documentWidth().
 * @param {number} height Height in pixels, from documentHeight().
 * @returns {string}
 */
function watermarkScreenStyle(width, height) {
  return [
    "display: inline !important",
    "opacity: 1 !important",
    "visibility: visible !important",
    "position: absolute !important",
    "top: 0 !important",
    "left: 0 !important",
    `min-width: ${width}px !important`,
    `min-height: ${height}px !important`,
    ...watermarkCommonStyle(),
    "print-color-adjust: exact !important",
  ].join("; ");
}

/**
 * Draws the watermark in the content process for documents matching the
 * Watermark policy configuration.
 */
export class WatermarkPolicyChild extends JSWindowActorChild {
  #content = null;
  #node = null;
  #resizeObserver = null;
  // Watermark configuration for this document, fetched from the parent when
  // the actor is created and updated by "Watermark:Refresh". Null until it has
  // been received, or when the policy isn't applied.
  #config = null;
  // Whether a "DOMContentLoaded"/"pageshow" event has fired, so we know the
  // document is ready to be watermarked once the configuration arrives.
  #loaded = false;

  /**
   * Fetches the watermark configuration from the parent.
   */
  async actorCreated() {
    let config;
    try {
      config = await this.sendQuery("Watermark:GetConfig");
    } catch (e) {
      // The actor may have been destroyed before the query resolved; there's
      // nothing to draw in that case.
      return;
    }

    // A "Watermark:Refresh" may have delivered a newer config while the query
    // was in flight; don't clobber it.
    this.#config ??= config;

    // The document may already have loaded while the configuration was in
    // flight, in which case nothing else will trigger the initial draw.
    if (this.#loaded && !this.#content && this.#config) {
      this.#applyWatermark();
    }
  }

  /**
   * @param {Event} event
   */
  handleEvent(event) {
    switch (event.type) {
      case "DOMContentLoaded":
      case "pageshow":
        this.#loaded = true;
        if (this.#config && !this.#content) {
          this.#applyWatermark();
        }
        break;
    }
  }

  /**
   * @param {ReceiveMessageArgument} message
   */
  receiveMessage(message) {
    switch (message.name) {
      case "Watermark:Refresh":
        this.#config = message.data.config;
        this.#applyWatermark();
        break;
    }
  }

  // Test-only introspection
  get isShowingWatermark() {
    return !!this.#content;
  }

  // Test-only introspection
  get hasReceivedConfig() {
    return !!this.#config;
  }

  /**
   * Whether the current document should be watermarked given `config`. Normal
   * documents always qualify: the actor is only constructed for them because a
   * configured site pattern already matched the document URI. Reader Mode
   * (about:reader) and View Source (view-source:) wrap another URL, so the
   * actor is also constructed for those; they qualify only when the wrapped
   * URL matches the configured patterns.
   *
   * @param {WatermarkConfig} config
   * @returns {boolean}
   */
  #matchesDocument(config) {
    let doc = this.document;
    if (!doc) {
      return false;
    }
    let documentURI = doc.documentURI;
    let url;
    if (documentURI.startsWith("view-source:")) {
      url = documentURI.substring("view-source:".length);
    } else if (documentURI.startsWith("about:reader")) {
      url = lazy.ReaderMode.getOriginalUrl(documentURI);
    } else {
      return true;
    }
    if (!url) {
      return false;
    }
    try {
      return new MatchPatternSet(config.match).matches(url);
    } catch (e) {
      lazy.log.error(`Failed to match wrapped document URL: ${e}`);
      return false;
    }
  }

  /**
   * Tears down watermark node.
   */
  didDestroy() {
    this.#destroyWatermark();
  }

  /**
   * (Re-)draws the on-screen watermark as anonymous content, and keeps it
   * sized to the document via a ResizeObserver. A no-op if no configuration
   * has been received yet, or the policy has just been removed.
   */
  #applyWatermark() {
    this.#destroyWatermark();

    let win = this.contentWindow;
    let doc = this.document;
    let config = this.#config;
    if (!win || !doc || !config) {
      return;
    }
    if (!this.#matchesDocument(config)) {
      return;
    }

    // Captured once per watermark application.
    let watermarkConfig = {
      ...config,
      timestamp: Temporal.Now.instant().toString({ smallestUnit: "second" }),
    };

    try {
      this.#content = doc.insertAnonymousContent({ includeInPrint: true });
      this.#node = this.#buildNode(watermarkConfig);
      this.#content.root.appendChild(this.#node);

      this.#resizeObserver = new win.ResizeObserver(() => {
        this.#node?.setAttribute(
          "style",
          watermarkScreenStyle(documentWidth(doc), documentHeight(doc))
        );
      });
      this.#resizeObserver.observe(doc.documentElement);
    } catch (e) {
      lazy.log.error(`Failed to draw watermark: ${e}`);
      this.#destroyWatermark();
    }
  }

  /**
   * Builds the anonymous content node that displays the on-screen watermark.
   *
   * @param {WatermarkConfig} config Watermark configuration.
   * @returns {Element}
   */
  #buildNode(config) {
    let doc = this.document;
    let container = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    container.setAttribute("id", "enterprise-watermark");
    container.setAttribute(
      "style",
      watermarkScreenStyle(documentWidth(doc), documentHeight(doc))
    );
    container.appendChild(
      watermarkSvg(doc, config, "enterprise-watermark-pattern")
    );
    return container;
  }

  /**
   * Undoes #applyWatermark, tearing down the resize observer and removing
   * the anonymous content node.
   */
  #destroyWatermark() {
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    this.#node = null;
    if (this.#content) {
      try {
        this.document.removeAnonymousContent(this.#content);
      } catch (e) {
        // The document the content was inserted into may already be gone;
        // ignore.
      }
      this.#content = null;
    }
  }
}
