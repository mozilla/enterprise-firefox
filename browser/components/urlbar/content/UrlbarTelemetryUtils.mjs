/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  UrlUtils: "resource://gre/modules/UrlUtils.sys.mjs",
  UrlbarUtils: "moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs",
});

/**
 * Stateless helpers for assembling the urlbar's engagement-telemetry snapshot.
 * They're split out so the parent-side recorder and a content-side collector
 * can build the same snapshot from their own `start()`/`record()` orchestration
 * without sharing state or each other's dependencies. Everything here is
 * derived purely from the DOM event, the picked result, and the search string,
 * so it runs on whichever side holds the input and view.
 */
export class UrlbarTelemetryUtils {
  /**
   * Classifies the action behind an engagement from its DOM event and the
   * picked element. This is the part of the snapshot that can only be resolved
   * content-side, where the event and element live.
   *
   * @param {?Event} event
   *   The DOM event, or null for paste&go / drop&go.
   * @param {object} details
   *   The interaction details; `details.element`/`details.selType` refine the
   *   action for picked commands and dismissals.
   * @param {string} defaultInteractionType
   *   The session's interaction type, used when there's no event.
   * @returns {string} The action string recorded in telemetry.
   */
  static actionFromEvent(event, details, defaultInteractionType) {
    if (!event) {
      return defaultInteractionType === "dropped" ? "drop_go" : "paste_go";
    }
    if (event.type === "blur") {
      return "blur";
    }
    if (event.type === "tabswitch") {
      return "tab_switch";
    }
    // dismiss_autofill temporarily blocks autofill suggestions rather than
    // removing history, but we still want to report it "dismiss" in telemetry.
    if (details.element?.dataset.command === "dismiss_autofill") {
      return "dismiss";
    }
    if (
      details.element?.dataset.command &&
      details.element.dataset.command !== "help"
    ) {
      return details.element.dataset.command;
    }
    if (details.selType === "dismiss") {
      return "dismiss";
    }
    if (MouseEvent.isInstance(event)) {
      // TODO (Bug 2018250): Don’t rely on `event` and use `selType` or
      // `details.element` if possible.
      return /** @type {HTMLElement} */ (event.target).classList.contains(
        "urlbar-go-button"
      )
        ? "go_button"
        : "click";
    }
    return "enter";
  }

  /**
   * Derives the character and word counts telemetry records from the search
   * string. The string itself is never recorded.
   *
   * numWords is not a perfect measurement, since it will return an incorrect
   * value for languages that do not use spaces or URLs containing spaces in
   * their query parameters, for example.
   *
   * @param {string} searchString
   *   The user's search string.
   * @returns {{numChars: string, numWords: string, searchWords: string[]}}
   */
  static parseSearchString(searchString) {
    let numChars = searchString.length.toString();
    let searchWords = searchString
      .substring(0, lazy.UrlbarUtils.MAX_TEXT_LENGTH)
      .trim()
      .split(lazy.UrlUtils.REGEXP_SPACES)
      .filter(t => t);
    let numWords = searchWords.length.toString();

    return {
      numChars,
      numWords,
      searchWords,
    };
  }

  /**
   * Derives the interaction type a session started with from its initiating
   * event. Callers apply any explicit interaction-type hint themselves, so this
   * only inspects the event and search string.
   *
   * @param {Event} event
   *   The event that started the session.
   * @param {string} [searchString]
   *   The search string related to the event, if any.
   * @returns {string} The interaction type.
   */
  static startInteractionType(event, searchString) {
    if (event.type == "input") {
      return lazy.UrlbarUtils.isPasteEvent(event) ? "pasted" : "typed";
    } else if (event.type == "drop") {
      return "dropped";
    } else if (event.type == "paste") {
      return "pasted";
    } else if (searchString) {
      return "typed";
    }
    return "topsites";
  }

  /**
   * Assembles the engagement snapshot a recording needs from the picked result
   * and the DOM event, synchronously at engagement time. Values that can only
   * be derived content-side (the `action`, the picked action key) are resolved
   * here, so the recording itself needs neither the event nor the element.
   *
   * @param {?Event} event
   *   The DOM event behind the engagement, or null for paste&go / drop&go.
   * @param {object} details
   *   The interaction details. `details.isSessionOngoing` is set here, as the
   *   recording expects.
   * @param {?object} startEventInfo
   *   The session's start info from `start()`, or null when no session is in
   *   progress.
   * @returns {?object} The snapshot to record from, or null when there is no
   *   session in progress to record.
   */
  static collectSnapshot(event, details, startEventInfo) {
    if (!startEventInfo) {
      return null;
    }
    if (
      !event &&
      startEventInfo.interactionType != "pasted" &&
      startEventInfo.interactionType != "dropped"
    ) {
      // If no event is passed, we must be executing either paste&go or drop&go.
      throw new Error("Event must be defined, unless input was pasted/dropped");
    }
    if (!details) {
      throw new Error("Invalid event details: " + details);
    }

    let action = this.actionFromEvent(
      event,
      details,
      startEventInfo.interactionType
    );

    /** @type {"abandonment" | "engagement"} */
    let method =
      action == "blur" || action == "tab_switch" ? "abandonment" : "engagement";

    if (method == "engagement") {
      // Not all engagements end the search session. The session remains ongoing
      // when certain commands are picked (like dismissal) and results that
      // enter search mode are picked. We should find a generalized way to
      // determine this instead of listing all the cases like this.
      details.isSessionOngoing = !!(
        [
          "dismiss",
          "inaccurate_location",
          "not_interested",
          "not_now",
          "opt_in",
          "show_less_frequently",
        ].includes(details.selType) ||
        details.result?.payload.providesSearchMode
      );
    }

    let { numChars, numWords, searchWords } = this.parseSearchString(
      details.searchString
    );

    let internalDetails = {
      ...details,
      event,
      provider: details.result?.providerName,
      selIndex: details.result?.rowIndex ?? -1,
      pickedActionKey: details.element?.dataset.action ?? null,
    };

    return {
      method,
      action,
      startEventInfo,
      numChars,
      numWords,
      searchWords,
      internalDetails,
    };
  }
}
