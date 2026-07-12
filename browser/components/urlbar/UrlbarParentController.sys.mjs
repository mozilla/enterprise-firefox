/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

/**
 * @import {BrowserSearchTelemetry} from "moz-src:///browser/components/search/BrowserSearchTelemetry.sys.mjs"
 * @import {ProvidersManager} from "moz-src:///browser/components/urlbar/UrlbarProvidersManager.sys.mjs"
 * @import {SapLocation, SmartbarInput} from "moz-src:///browser/components/urlbar/content/SmartbarInput.mjs"
 * @import {UrlbarView} from "chrome://browser/content/urlbar/UrlbarView.mjs"
 * @import {WindowMode} from "moz-src:///browser/components/urlbar/content/UrlbarInput.mjs"
 */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ExtensionUtils: "resource://gre/modules/ExtensionUtils.sys.mjs",
  Interactions: "moz-src:///browser/components/places/Interactions.sys.mjs",
  ProvidersManager:
    "moz-src:///browser/components/urlbar/UrlbarProvidersManager.sys.mjs",
  SearchService: "moz-src:///toolkit/components/search/SearchService.sys.mjs",
  UrlbarPrefs: "moz-src:///browser/components/urlbar/UrlbarPrefs.sys.mjs",
  UrlbarProviderSemanticHistorySearch:
    "moz-src:///browser/components/urlbar/UrlbarProviderSemanticHistorySearch.sys.mjs",
  UrlbarShared: "chrome://browser/content/urlbar/UrlbarShared.mjs",
  UrlbarTelemetryUtils:
    "chrome://browser/content/urlbar/UrlbarTelemetryUtils.mjs",
  UrlbarUtils: "moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "logger", () =>
  lazy.UrlbarShared.getLogger({ prefix: "Controller" })
);

/**
 * The address bar controller handles queries from the address bar, obtains
 * results and returns them to the UI for display.
 *
 * In the parent/child controller split, this class owns the bits that must
 * run in the parent process: the {@link ProvidersManager}, query lifecycle,
 * and parent-only telemetry. It is reached by `UrlbarChildController`
 * through the `Urlbar` JSWindowActor pair. For chrome `<moz-urlbar>`
 * instances both controllers are in the parent process and
 * `UrlbarChildController` holds a direct reference to this class; future
 * content-process consumers (e.g. about:newtab) will route calls through
 * the actor pair instead.
 *
 * Listeners may be added to listen for the results. They may support the
 * following methods which may be called when a query is run:
 *
 * - onQueryStarted(queryContext)
 * - onQueryResults(queryContext)
 * - onQueryCancelled(queryContext)
 * - onQueryFinished(queryContext)
 * - onQueryResultRemoved(index)
 * - onViewOpen()
 * - onViewClose()
 */
export class UrlbarParentController {
  // The paired UrlbarChildController, which registers itself via setChild().
  // Listener registration and notification dispatch live on it, keeping
  // dispatch on the side where the listeners (the view, the event bufferer)
  // live — required once `<moz-urlbar>` runs in a content process. The child
  // is always set before any query runs.
  #child = null;

  /**
   * Initialises the class. Takes the standalone data the controller needs
   * rather than a DOM input, so it can also serve a content-process
   * `<moz-urlbar>` whose input lives across the actor boundary. The live
   * input/view are reached at runtime through the paired
   * `UrlbarChildController`.
   *
   * @param {object} options
   *   The initial options for UrlbarParentController.
   * @param {string} options.sapName
   *   The search access point name, e.g. `urlbar`, `searchbar`.
   * @param {boolean} [options.isPrivate]
   *   Whether the controller serves a private-browsing input.
   * @param {object} [options.manager]
   *   Optional fake providers manager to override the built-in providers manager.
   *   Intended for use in unit tests only.
   */
  constructor({ sapName, isPrivate = false, manager }) {
    if (!sapName) {
      throw new Error("Missing options: sapName");
    }

    this.sapName = sapName;
    this.isPrivate = isPrivate;

    /**
     * @type {ProvidersManager}
     */
    this.manager =
      manager || lazy.ProvidersManager.getInstanceForSap(this.sapName);

    this.engagementEvent = new TelemetryEvent(this);
  }

  /**
   * The platform constant.
   *
   * @type {string}
   */
  get platform() {
    return AppConstants.platform;
  }

  /**
   * The input, owned by the paired `UrlbarChildController`. The parent no
   * longer holds the input, browser window, or view directly; it reads them
   * through the child for the query-lifecycle and telemetry call sites that
   * still need them. These getters go away together with the `#child`
   * back-reference once those call sites get their data another way.
   *
   * @type {UrlbarInput}
   */
  get input() {
    return this.#child?.input;
  }

  /**
   * The browser window the input lives in.
   *
   * @type {ChromeWindow}
   */
  get browserWindow() {
    return this.#child?.browserWindow;
  }

  /**
   * The view.
   *
   * @type {UrlbarView}
   */
  get view() {
    return this.#child?.view;
  }

  /**
   * Returns the view template a dynamic result's provider uses to build its
   * row. Mediates the view's access to the (parent-process) provider.
   *
   * @param {UrlbarResult} result The dynamic result.
   * @returns {object} The view template.
   */
  getViewTemplate(result) {
    return this.manager
      .getProvider(result.providerName)
      .getViewTemplate(result);
  }

  /**
   * Returns the view update a dynamic result's provider produces for the
   * given node ids. Mediates the view's access to the (parent-process)
   * provider.
   *
   * @param {UrlbarResult} result The dynamic result.
   * @param {object} idsByName A map from node names to element ids.
   * @returns {Promise<object>} The view update.
   */
  getViewUpdate(result, idsByName) {
    return this.manager
      .getProvider(result.providerName)
      .getViewUpdate(result, idsByName);
  }

  /**
   * Notifies a result's provider that the result is about to be selected.
   * Mediates the view's access to the (parent-process) provider.
   *
   * @param {UrlbarResult} result The result being selected.
   * @param {Element} element The selected element.
   */
  onBeforeSelection(result, element) {
    this.manager
      .getProvider(result?.providerName)
      ?.tryMethod("onBeforeSelection", result, element);
  }

  /**
   * Notifies a result's provider that the result was selected. Mediates the
   * view's access to the (parent-process) provider.
   *
   * @param {UrlbarResult} result The selected result.
   * @param {Element} element The selected element.
   */
  onSelection(result, element) {
    this.manager
      .getProvider(result?.providerName)
      ?.tryMethod("onSelection", result, element);
  }

  /**
   * Returns the result menu commands a result's provider offers, if any.
   * Mediates the view's access to the (parent-process) provider.
   *
   * @param {UrlbarResult} result The result.
   * @param {boolean} isPrivate Whether the query is private.
   * @returns {?UrlbarResultCommand[]} The commands, or null/undefined.
   */
  getResultCommands(result, isPrivate) {
    return this.manager
      .getProvider(result.providerName)
      ?.tryMethod("getResultCommands", result, isPrivate);
  }

  /**
   * Runs a one-off query and returns its heuristic result. Mediates the
   * input's access to the (parent-process) providers manager, e.g. for
   * paste-and-go and drop-and-go where the input needs the heuristic result
   * without an open view.
   *
   * @param {UrlbarQueryContext} queryContext The query context to run.
   * @returns {Promise<UrlbarResult>} The heuristic result.
   */
  async getHeuristicResult(queryContext) {
    await this.manager.startQuery(queryContext);
    return queryContext.heuristicResult;
  }

  /**
   * Takes a query context and starts the query based on the user input.
   *
   * @param {UrlbarQueryContext} queryContext The query details.
   * @returns {Promise<UrlbarQueryContext>}
   *   The updated query context.
   */
  async startQuery(queryContext) {
    // Cancel any running query.
    this.cancelQuery();

    // Wrap the external queryContext, to track a unique object, in case
    // the external consumer reuses the same context multiple times.
    // This also allows to add properties without polluting the context.
    // Note this can't be null-ed or deleted once a query is done, because it's
    // used by #dismissSelectedResult and handleKeyNavigation, that can run after
    // a query is cancelled or finished.
    let contextWrapper = (this._lastQueryContextWrapper = { queryContext });

    queryContext.lastResultCount = 0;
    queryContext.firstTimerId =
      Glean.urlbar.autocompleteFirstResultTime.start();
    queryContext.sixthTimerId =
      Glean.urlbar.autocompleteSixthResultTime.start();

    // For proper functionality we must ensure this notification is fired
    // synchronously, as soon as startQuery is invoked, but after any
    // notifications related to the previous query.
    this.notify(lazy.UrlbarShared.NOTIFICATIONS.QUERY_STARTED, queryContext);
    await this.manager.startQuery(queryContext, this);

    // If the query has been cancelled, onQueryFinished was notified already.
    // Note this._lastQueryContextWrapper may have changed in the meanwhile.
    if (
      contextWrapper === this._lastQueryContextWrapper &&
      !contextWrapper.done
    ) {
      contextWrapper.done = true;
      // TODO (Bug 1549936) this is necessary to avoid leaks in PB tests.
      this.manager.cancelQuery(queryContext);
      this.notify(lazy.UrlbarShared.NOTIFICATIONS.QUERY_FINISHED, queryContext);
    }

    return queryContext;
  }

  /**
   * Cancels an in-progress query. Note, queries may continue running if they
   * can't be cancelled.
   */
  cancelQuery() {
    // If the query finished already, don't handle cancel.
    if (!this._lastQueryContextWrapper || this._lastQueryContextWrapper.done) {
      return;
    }

    this._lastQueryContextWrapper.done = true;

    let { queryContext } = this._lastQueryContextWrapper;

    Glean.urlbar.autocompleteFirstResultTime.cancel(queryContext.firstTimerId);
    queryContext.firstTimerId = 0;
    Glean.urlbar.autocompleteSixthResultTime.cancel(queryContext.sixthTimerId);
    queryContext.sixthTimerId = 0;

    this.manager.cancelQuery(queryContext);
    this.notify(lazy.UrlbarShared.NOTIFICATIONS.QUERY_CANCELLED, queryContext);
    this.notify(lazy.UrlbarShared.NOTIFICATIONS.QUERY_FINISHED, queryContext);
  }

  /**
   * Receives results from a query.
   *
   * @param {UrlbarQueryContext} queryContext The query details.
   */
  receiveResults(queryContext) {
    if (queryContext.lastResultCount < 1 && queryContext.results.length >= 1) {
      Glean.urlbar.autocompleteFirstResultTime.stopAndAccumulate(
        queryContext.firstTimerId
      );
      queryContext.firstTimerId = 0;
    }
    if (queryContext.lastResultCount < 6 && queryContext.results.length >= 6) {
      Glean.urlbar.autocompleteSixthResultTime.stopAndAccumulate(
        queryContext.sixthTimerId
      );
      queryContext.sixthTimerId = 0;
    }

    // When the input is in-process (direct path), let it react to the first
    // result and bail before notifying if it took over (e.g. entered search
    // mode and restarted the query). On the message path the input lives across
    // the boundary, so it runs `onFirstResult` content-side when it receives the
    // results instead, and `speculativeConnect` is skipped (it needs the
    // window).
    if (queryContext.firstResultChanged && this.input) {
      if (this.input.onFirstResult(queryContext.results[0])) {
        // The input canceled the query and started a new one.
        return;
      }

      // The first time we receive results try to connect to the heuristic
      // result.
      this.speculativeConnect(
        queryContext.results[0],
        queryContext,
        "resultsadded"
      );
    }

    this.notify(lazy.UrlbarShared.NOTIFICATIONS.QUERY_RESULTS, queryContext);
    // Update lastResultCount after notifying, so the view can use it.
    queryContext.lastResultCount = queryContext.results.length;
  }

  /**
   * Sets the paired UrlbarChildController, which owns listener registration
   * and notification dispatch. It must be set before any query runs, since
   * the query lifecycle notifies through it.
   *
   * @param {object} child The paired UrlbarChildController.
   */
  setChild(child) {
    this.#child = child;
  }

  /**
   * Tries to initialize a speculative connection on a result.
   * Speculative connections are only supported for a subset of all the results.
   *
   * Speculative connect to:
   *  - Search engine heuristic results
   *  - autofill results
   *  - http/https results
   *
   * @param {UrlbarResult} result The result to speculative connect to.
   * @param {UrlbarQueryContext} context The queryContext
   * @param {string} reason Reason for the speculative connect request.
   */
  speculativeConnect(result, context, reason) {
    // Never speculative connect in private contexts.
    if (!this.input || context.isPrivate || !context.results.length) {
      return;
    }

    switch (reason) {
      case "resultsadded": {
        // We should connect to an heuristic result, if it exists.
        if (
          (result == context.results[0] && result.heuristic) ||
          result.autofill
        ) {
          if (result.type == lazy.UrlbarShared.RESULT_TYPE.SEARCH) {
            // Speculative connect only if search suggestions are enabled.
            if (
              (lazy.UrlbarPrefs.get("suggest.searches") ||
                context.sapName == "searchbar") &&
              lazy.UrlbarPrefs.get("browser.search.suggest.enabled")
            ) {
              let engine = lazy.SearchService.getEngineByName(
                result.payload.engine
              );
              lazy.UrlbarUtils.setupSpeculativeConnection(
                engine,
                this.browserWindow
              );
            }
          } else if (result.autofill) {
            const { url } = lazy.UrlbarUtils.getUrlFromResult(result);
            if (!url) {
              return;
            }

            lazy.UrlbarUtils.setupSpeculativeConnection(
              url,
              this.browserWindow
            );
          }
        }
        return;
      }
      case "mousedown": {
        const { url } = lazy.UrlbarUtils.getUrlFromResult(result);
        if (!url) {
          return;
        }

        // On mousedown, connect only to http/https urls.
        if (url.startsWith("http")) {
          lazy.UrlbarUtils.setupSpeculativeConnection(url, this.browserWindow);
        }
        return;
      }
      default: {
        throw new Error("Invalid speculative connection reason");
      }
    }
  }

  /**
   * Removes a result from the current query context and notifies listeners.
   * Heuristic results cannot be removed.
   *
   * @param {UrlbarResult} result
   *   The result to remove.
   */
  removeResult(result) {
    if (!result || result.heuristic) {
      return;
    }

    if (!this._lastQueryContextWrapper) {
      console.error("Cannot remove result, last query not present");
      return;
    }
    let { queryContext } = this._lastQueryContextWrapper;

    let index = queryContext.results.indexOf(result);
    if (index < 0) {
      console.error("Failed to find the selected result in the results");
      return;
    }

    queryContext.results.splice(index, 1);
    this.notify(lazy.UrlbarShared.NOTIFICATIONS.QUERY_RESULT_REMOVED, index);
  }

  /**
   * Set the query context cache.
   *
   * @param {UrlbarQueryContext} queryContext the object to cache.
   */
  setLastQueryContextCache(queryContext) {
    this._lastQueryContextWrapper = { queryContext };
  }

  /**
   * Clear the previous query context cache.
   */
  clearLastQueryContextCache() {
    this._lastQueryContextWrapper = null;
  }

  /**
   * Notifies listeners of results, by dispatching through the paired
   * UrlbarChildController, which owns the listeners.
   *
   * @param {string} name Name of the notification.
   * @param {object} params Parameters to pass with the notification.
   */
  notify(name, ...params) {
    this.#child.notify(name, ...params);
  }
}

/**
 * Tracks and records telemetry events for the given category, if provided,
 * otherwise it's a no-op.
 * It is currently designed around the "urlbar" category, even if it can
 * potentially be extended to other categories.
 * To record an event, invoke start() with a starting event, then either
 * invoke record() with a final event, or discard() to drop the recording.
 *
 * @see Events.yaml
 */
class TelemetryEvent {
  /**
   * @param {UrlbarParentController} controller
   *  The associated UrlbarParentController.
   */
  constructor(controller) {
    this._controller = controller;
    lazy.UrlbarPrefs.addObserver(this);
    this.#readPingPrefs();
    this._lastSearchDetailsForDisableSuggestTracking = null;
  }

  /**
   * Start measuring the elapsed time from a user-generated event.
   * After this has been invoked, any subsequent calls to start() are ignored,
   * until either record() or discard() are invoked. Thus, it is safe to keep
   * invoking this on every input event as the user is typing, for example.
   *
   * @param {event} event A DOM event.
   * @param {UrlbarQueryContext} queryContext A queryContext.
   * @param {string} [searchString] Pass a search string related to the event if
   *        you have one.  The event by itself sometimes isn't enough to
   *        determine the telemetry details we should record.
   * @param {string} [interactionType] An explicit interaction type for the
   *        session, used in preference to one derived from the event. The view
   *        passes this when reopening a prior search ("returned").
   * @throws This should never throw, or it may break the urlbar.
   * @see {@link https://firefox-source-docs.mozilla.org/browser/urlbar/telemetry.html}
   */
  start(event, queryContext, searchString = null, interactionType = null) {
    if (this._startEventInfo) {
      if (this._startEventInfo.interactionType == "topsites") {
        // If the most recent event came from opening the results pane with an
        // empty string replace the interactionType (that would be "topsites")
        // with one for the current event to better measure the user flow.
        this._startEventInfo.interactionType =
          interactionType ||
          lazy.UrlbarTelemetryUtils.startInteractionType(event, searchString);
        this._startEventInfo.searchString = searchString;
      } else if (
        this._startEventInfo.interactionType == "returned" &&
        (!searchString ||
          this._startEventInfo.searchString[0] != searchString[0])
      ) {
        // In case of a "returned" interaction ongoing, the user may either
        // continue the search, or restart with a new search string. In that case
        // we want to change the interaction type to "restarted".
        // Detecting all the possible ways of clearing the input would be tricky,
        // thus this makes a guess by just checking the first char matches; even if
        // the user backspaces a part of the string, we still count that as a
        // "returned" interaction.
        this._startEventInfo.interactionType = "restarted";
      }

      // start is invoked on a user-generated event, but we only count the first
      // one.  Once an engagement or abandonment happens, we clear _startEventInfo.
      return;
    }

    if (!event) {
      console.error("Must always provide an event");
      return;
    }
    const validEvents = [
      "click",
      "command",
      "drop",
      "input",
      "keydown",
      "mousedown",
      "paste",
      "tabswitch",
      "focus",
    ];
    if (!validEvents.includes(event.type)) {
      console.error("Can't start recording from event type: ", event.type);
      return;
    }

    this._startEventInfo = {
      timeStamp: event.timeStamp || ChromeUtils.now(),
      interactionType:
        interactionType ||
        lazy.UrlbarTelemetryUtils.startInteractionType(event, searchString),
      searchString,
    };
  }

  /**
   * @typedef {object} ActionDetails
   *   An object describing action details that are recorded in an event.
   * @property {HTMLElement} [element]
   *   The picked view element.
   * @property {UrlbarResult} [result]
   *   The engaged result. This should be set to the result related to the
   *   picked element.
   * @property {UrlbarResult[]} [visibleResults]
   *   The visible results captured when a deferred (disable/bounce) recording
   *   is tracked, so `selIndex` indexes into the same set the recording reports.
   * @property {boolean} [isSessionOngoing]
   *   Set to true if the search session is still ongoing.
   * @property {object} [searchMode]
   *   The searchMode object to record.
   * @property {string} searchSource
   *   The source of the search event.
   * @property {string} [searchString]
   *   The user's search string. Note that this string is not sent with telemetry
   *   data. It is only used locally to discern other data, such as the number
   *   of characters and words in the string.
   * @property {string} [selType]
   *   The Type of the selected element, undefined for "blur".
   *   One of "unknown", "autofill", "visiturl", "bookmark", "help", "history",
   *   "keyword", "searchengine", "searchsuggestion", "switchtab", "remotetab",
   *   "extension", "oneoff", "dismiss".
   * @property {SapLocation} [location]
   *   The location where the interaction occurred.
   *   Required when sap is "smartbar".
   * @property {WindowMode} [windowMode]
   *   The window mode: classic, private, or smartwindow.
   */

  /**
   * @typedef {object} AdditionalActionDetails
   * @property {string} provider
   *   The name of the `UrlbarProvider` that provided the selected result.
   * @property {number} selIndex
   *   The index of the selected result.
   */

  /**
   * @typedef {ActionDetails & AdditionalActionDetails} InternalActionDetails
   */

  /**
   * Record an engagement telemetry event.
   * When the user picks a result from a search through the mouse or keyboard,
   * an engagement event is recorded. If instead the user abandons a search, by
   * blurring the input field, an abandonment event is recorded.
   *
   * On return, `details.isSessionOngoing` will be set to true if the engagement
   * did not end the search session. Not all engagements end the session. The
   * session remains ongoing when certain commands are picked (like dismissal)
   * and results that enter search mode are picked.
   *
   * @param {?event} event
   *   A DOM event. Note: event can be null, that usually happens for paste&go
   *   or drop&go. If there's no _startEventInfo this is a no-op.
   * @param {ActionDetails} details
   */
  record(event, details) {
    // Prevent re-entering `record()`. This can happen because
    // `#internalRecord()` will notify an engagement to the provider, that may
    // execute an action blurring the input field. Then both an engagement
    // and an abandonment would be recorded for the same session.
    // Nulling out `_startEventInfo` doesn't save us in this case, because it
    // happens after `#internalRecord()`, and `isSessionOngoing` must be
    // calculated inside it.
    if (this.#handlingRecord) {
      return;
    }

    // This should never throw, or it may break the urlbar.
    try {
      this.#handlingRecord = true;
      this.#internalRecord(event, details);
    } catch (ex) {
      console.error("Could not record event: ", ex);
    } finally {
      this.#handlingRecord = false;

      // Reset the start event info except for engagements that do not end the
      // search session. In that case, the view stays open and further
      // engagements are possible and should be recorded when they occur.
      // (`details.isSessionOngoing` is not a param; rather, it's set by
      // `#internalRecord()`.)
      if (!details.isSessionOngoing) {
        this._startEventInfo = null;
        this._discarded = false;
      }
    }
  }

  /**
   * Internal record method, see the record function.
   *
   * @param {Event} event
   * @param {ActionDetails} details
   */
  #internalRecord(event, details) {
    let snapshot = lazy.UrlbarTelemetryUtils.collectSnapshot(
      event,
      details,
      this._startEventInfo
    );
    if (snapshot) {
      this.#recordEngagement(snapshot);
    }
  }

  /**
   * Records the engagement (or abandonment) telemetry from a snapshot gathered
   * by `UrlbarTelemetryUtils.collectSnapshot()`. Runs parent-side: it reads the
   * parent's query context, records Glean telemetry and exposures, and notifies
   * the providers.
   *
   * @param {object} snapshot
   *   The snapshot to record from.
   */
  #recordEngagement(snapshot) {
    let {
      method,
      action,
      startEventInfo,
      numChars,
      numWords,
      searchWords,
      internalDetails,
    } = snapshot;

    let { queryContext } = this._controller._lastQueryContextWrapper || {};

    // The engagement is recorded immediately, so the live results still match
    // the picked selIndex; the deferred disable/bounce paths instead capture
    // this at tracking time (see startTrackingDisableSuggest/BounceEvent).
    const visibleResults = this.#engagementData.visibleResults;

    this.#recordSearchEngagementTelemetry(method, startEventInfo, {
      action,
      numChars,
      numWords,
      searchWords,
      provider: internalDetails.provider,
      searchSource: internalDetails.searchSource,
      searchMode: internalDetails.searchMode,
      selIndex: internalDetails.selIndex,
      visibleResults,
      selType: internalDetails.selType,
      pickedActionKey: internalDetails.pickedActionKey,
      location: internalDetails.location,
      windowMode: internalDetails.windowMode,
      ...this.#getOptionalSmartbarTelemetry(internalDetails.searchSource),
    });

    if (!internalDetails.isSessionOngoing) {
      this.#recordExposures(queryContext);
    }

    // Start tracking for a disable event if there was a Suggest result
    // during an engagement or abandonment event.
    if (
      (method == "engagement" || method == "abandonment") &&
      visibleResults.some(r => r.providerName == "UrlbarProviderQuickSuggest")
    ) {
      this.startTrackingDisableSuggest(internalDetails.event, internalDetails);
    }

    try {
      this._controller.manager.notifyEngagementChange(
        method,
        queryContext,
        internalDetails,
        this._controller
      );
    } catch (error) {
      // We handle and report any error here to avoid hitting the record()
      // handler, that would look like we didn't send telemetry at all.
      console.error(error);
    }
  }

  /**
   * Converts a search source string to a sap string.
   * Both are the same concept but they have slightly different values.
   * The sap string is used in urlbar.* telemetry.
   *
   * @see {BrowserSearchTelemetry.KNOWN_SEARCH_SOURCES} For an overview
   * of the available values of search source and which telemetry uses it.
   *
   * @param {string} searchSource
   *   The search source string to convert.
   * @returns {null|"urlbar"|"searchbar"|"smartbar"|"handoff"|"urlbar_newtab"|"urlbar_addonpage"}
   *   The sap value for urlbar.* telemetry or null if the browser window
   *   already started closing. In that case, no telemetry should be recorded.
   */
  #searchSourceToSap(searchSource) {
    if (searchSource === "urlbar_handoff") {
      return "handoff";
    }
    // TODO (bug 2024630): Ideally, we would not add every new SAP here.
    if (searchSource === "searchbar") {
      return "searchbar";
    }
    if (searchSource === "smartbar") {
      return "smartbar";
    }
    let browserWindow = this._controller.browserWindow;
    if (browserWindow.closed) {
      // If the browser window has already started closing, then we bail-out.
      // We would rather return no telemetry than have telemetry with an
      // incorrect SAP. Generally, this should only happen in tests, since
      // the timing would need to be very close for the code not to have got
      // here before the user started closing the window.
      return null;
    }
    if (browserWindow.isBlankPageURL(browserWindow.gBrowser.currentURI.spec)) {
      return "urlbar_newtab";
    }
    if (lazy.ExtensionUtils.isExtensionUrl(browserWindow.gBrowser.currentURI)) {
      return "urlbar_addonpage";
    }
    return "urlbar";
  }

  /**
   * The content-side state the engagement-telemetry recording needs.
   *
   * @type {{searchMode: object, visibleResults: UrlbarResult[], viewIsOpen: boolean, searchSource: string}}
   */
  get #engagementData() {
    return {
      searchMode: this._controller.input.searchMode,
      visibleResults: this._controller.view?.visibleResults ?? [],
      viewIsOpen: this._controller.view?.isOpen ?? false,
      searchSource: this._controller.input.getSearchSource(),
    };
  }

  /**
   * The smartbar-only telemetry fields, read fresh from the input.
   *
   * @type {{chatId: string, intent: string, model: string}}
   */
  get #smartbarData() {
    // Only read when the SAP is `smartbar`, so the input is a SmartbarInput.
    const input = /** @type {SmartbarInput} */ (
      /** @type {unknown} */ (this._controller.input)
    );
    return {
      chatId: input.conversationTelemetryInfo?.chat_id ?? "",
      intent: input.smartbarAction ?? "",
      model: input.modelName ?? "",
    };
  }

  /**
   * Records the relevant telemetry information for the given parameters.
   *
   * @param {"abandonment" | "engagement" | "disable" | "bounce"} method
   * @param {{interactionType: any, searchString: string }} startEventInfo
   * @param {object} details
   * @param {string} details.action
   *   The type of action that caused this event. This may be recorded in the
   *   engagement_type field of the event.
   * @param {number} details.numWords
   *   The length of words used for the search.
   * @param {number} details.numChars
   *   The length of string used for the search. It includes whitespaces.
   * @param {string} details.provider
   *   The name of the `UrlbarProvider` that provided the selected result.
   * @param {string[]} details.searchWords
   *   The search words entered, used to determine if the search has been refined.
   * @param {string} details.searchSource
   *   The source of the search event.
   * @param {object} details.searchMode
   *   The searchMode object to record.
   * @param {number} details.selIndex
   *   The index of the selected result.
   * @param {UrlbarResult[]} details.visibleResults
   *   The results shown when the engagement was captured. Passed in (rather than
   *   read fresh here) so a deferred recording indexes `selIndex` into the same
   *   results it was captured against.
   * @param {string} details.selType
   *   The Type of the selected element, undefined for "blur".
   *   One of "unknown", "autofill", "visiturl", "bookmark", "help", "history",
   *   "keyword", "searchengine", "searchsuggestion", "switchtab", "remotetab",
   *   "extension", "oneoff", "dismiss".
   * @param {string|null} [details.pickedActionKey]
   *   The `data-action` of the action button the user picked, when selType is
   *   "action". Used to disambiguate which action was picked in the global
   *   actions row, which can contain multiple action buttons.
   * @param {number} [details.viewTime]
   *   The length of the view time in milliseconds.
   * @param {SapLocation} [details.location]
   *   The location where the interaction occurred.
   *   Required when sap is "smartbar".
   * @param {WindowMode} [details.windowMode]
   *   The window mode: classic, private, or smartwindow.
   * @param {string} [details.chatId]
   *   UUID for this smart window session. Unique identifier for each chat
   *   conversation. Only set when sap is `smartbar`.
   * @param {string} [details.intent]
   *   The detected intent for the input. Only set when sap is `smartbar`.
   * @param {string} [details.model]
   *   Model selected by the user. Only set when sap is `smartbar`.
   */
  #recordSearchEngagementTelemetry(
    method,
    startEventInfo,
    {
      action,
      numWords,
      numChars,
      provider,
      searchWords,
      searchSource,
      searchMode,
      selIndex,
      visibleResults,
      selType,
      pickedActionKey = null,
      viewTime = 0,
      location = null,
      chatId = "",
      intent = "",
      model = "",
      windowMode,
    }
  ) {
    let sap = this.#searchSourceToSap(searchSource);
    if (!sap) {
      return;
    }
    let engagementData = this.#engagementData;
    // The extra_key `location` is optional, but required for the smartbar.
    // TODO (bug 2024631): Support location for all SAPs.
    if (this._controller.sapName === "smartbar" && !location) {
      throw new Error(
        "Telemetry extra_key `location` is required for smartbar"
      );
    }
    searchMode = searchMode ?? engagementData.searchMode;

    // Distinguish user typed search strings from persisted search terms.
    const interaction = this.#getInteractionType(
      method,
      startEventInfo,
      searchSource,
      searchWords,
      searchMode
    );
    const search_mode = this.#getSearchMode(searchMode);
    let numResults = visibleResults.length;
    let groups = visibleResults
      .map(r => lazy.UrlbarUtils.searchEngagementTelemetryGroup(r))
      .join(",");
    let results = visibleResults
      .map(r => lazy.UrlbarUtils.searchEngagementTelemetryType(r))
      .join(",");
    let actions = visibleResults
      .map(r => lazy.UrlbarUtils.searchEngagementTelemetryAction(r))
      .filter(v => v)
      .join(",");
    let available_semantic_sources = this.#getAvailableSemanticSources().join();
    const search_engine_default_id =
      lazy.SearchService.defaultEngine.telemetryId;

    switch (method) {
      case "engagement": {
        let selected_result = lazy.UrlbarUtils.searchEngagementTelemetryType(
          visibleResults[selIndex],
          selType
        );

        if (selType == "action") {
          let actionKey = lazy.UrlbarUtils.searchEngagementTelemetryAction(
            visibleResults[selIndex],
            pickedActionKey
          );
          selected_result = `action_${actionKey}`;
        }

        if (selected_result === "input_field" && !engagementData.viewIsOpen) {
          numResults = 0;
          groups = "";
          results = "";
        }

        let eventInfo = {
          sap,
          interaction,
          search_mode,
          n_chars: numChars.toString(),
          n_words: numWords.toString(),
          n_results: numResults.toString(),
          selected_position: (selIndex + 1).toString(),
          selected_result,
          provider,
          engagement_type:
            selType === "help" ||
            selType === "dismiss" ||
            selType === "ask_button" ||
            selType === "navigate_button" ||
            selType === "search_button"
              ? selType
              : action,
          search_engine_default_id,
          groups,
          results,
          actions,
          available_semantic_sources,
          window_mode: windowMode,
          ...(sap === "smartbar"
            ? { location, chat_id: chatId, intent, model }
            : {}),
        };
        lazy.logger.info(`engagement event:`, eventInfo);
        Glean.urlbar.engagement.record(eventInfo);
        break;
      }
      case "abandonment": {
        let eventInfo = {
          abandonment_type: action,
          sap,
          interaction,
          search_mode,
          n_chars: numChars.toString(),
          n_words: numWords.toString(),
          n_results: numResults.toString(),
          search_engine_default_id,
          groups,
          results,
          actions,
          available_semantic_sources,
          window_mode: windowMode,
          ...(sap === "smartbar"
            ? { location, chat_id: chatId, intent, model }
            : {}),
        };
        lazy.logger.info(`abandonment event:`, eventInfo);
        Glean.urlbar.abandonment.record(eventInfo);
        break;
      }
      case "disable": {
        const previousEvent =
          action == "blur" || action == "tab_switch"
            ? "abandonment"
            : "engagement";
        let selected_result = "none";
        if (previousEvent == "engagement") {
          selected_result = lazy.UrlbarUtils.searchEngagementTelemetryType(
            visibleResults[selIndex],
            selType
          );
        }
        let eventInfo = {
          sap,
          interaction,
          search_mode,
          search_engine_default_id,
          n_chars: numChars.toString(),
          n_words: numWords.toString(),
          n_results: numResults.toString(),
          selected_result,
          results,
          feature: "suggest",
          window_mode: windowMode,
          ...(sap === "smartbar"
            ? { location, chat_id: chatId, intent, model }
            : {}),
        };
        lazy.logger.info(`disable event:`, eventInfo);
        Glean.urlbar.disable.record(eventInfo);
        break;
      }
      case "bounce": {
        let selected_result = lazy.UrlbarUtils.searchEngagementTelemetryType(
          visibleResults[selIndex],
          selType
        );
        let eventInfo = {
          sap,
          interaction,
          search_mode,
          search_engine_default_id,
          n_chars: numChars.toString(),
          n_words: numWords.toString(),
          n_results: numResults.toString(),
          selected_result,
          selected_position: (selIndex + 1).toString(),
          provider,
          engagement_type:
            selType === "help" || selType === "dismiss" ? selType : action,
          results,
          view_time: viewTime.toString(),
          threshold: lazy.UrlbarPrefs.get(
            "events.bounce.maxSecondsFromLastSearch"
          ),
          window_mode: windowMode,
          ...(sap === "smartbar"
            ? { location, chat_id: chatId, intent, model }
            : {}),
        };
        lazy.logger.info(`bounce event:`, eventInfo);
        Glean.urlbar.bounce.record(eventInfo);
        break;
      }
      default: {
        console.error(`Unknown telemetry event method: ${method}`);
      }
    }
  }

  /**
   * Returns Smart Window telemetry data for SAP `smartbar`.
   *
   * @param {string} searchSource
   *   The search source identifier.
   * @returns {{ chatId: string, intent: string, model: string } | null}
   *   Telemetry for the smartbar.
   */
  #getOptionalSmartbarTelemetry(searchSource) {
    const isSmartbar = this.#searchSourceToSap(searchSource) === "smartbar";
    if (!isSmartbar) {
      return null;
    }
    return this.#smartbarData;
  }

  /**
   * Retrieves available semantic search sources.
   * Ensure it is the provider initializing the semantic manager, since it
   * provides the right configuration for the singleton.
   *
   * @returns {Array<string>} Array of found sources, will contain just "none"
   *   if no sources were found.
   */
  #getAvailableSemanticSources() {
    let sources = [];
    try {
      const semanticManager =
        lazy.UrlbarProviderSemanticHistorySearch.semanticManager;
      const isSmartbar = this._controller.sapName === "smartbar";
      if (
        isSmartbar
          ? semanticManager.isEnabledForSmartWindow
          : semanticManager.canUseSemanticSearch
      ) {
        sources.push("history");
      }
    } catch (e) {
      lazy.logger.error("Error getting the semantic manager:", e);
    }
    if (!sources.length) {
      sources.push("none");
    }
    return sources;
  }

  /**
   * @param {UrlbarQueryContext} queryContext
   */
  #recordExposures(queryContext) {
    let exposures = this.#exposures;
    this.#exposures = [];
    this.#tentativeExposures = [];
    if (!exposures.length) {
      return;
    }
    let { searchSource, visibleResults } = this.#engagementData;
    let sap = this.#searchSourceToSap(searchSource);
    if (!sap) {
      // Window started closing.
      return;
    }

    let terminalByType = new Map();
    let keywordExposureRecorded = false;
    for (let { weakResult, resultType, keyword } of exposures) {
      let terminal = false;
      let result = weakResult.get();
      if (result) {
        this.#exposureResults.delete(result);

        let endResults = result.isHiddenExposure
          ? queryContext.results
          : visibleResults;
        terminal = endResults?.includes(result);
      }

      terminalByType.set(resultType, terminal);

      // Record the `keyword_exposure` event if there's a keyword.
      if (keyword) {
        let data = {
          keyword,
          terminal: terminal.toString(),
          result: resultType,
          sap,
        };
        lazy.logger.debug("Recording keyword_exposure event", data);
        Glean.urlbar.keywordExposure.record(data);
        keywordExposureRecorded = true;
      }
    }

    // Record the `exposure` event.
    let tuples = [...terminalByType].sort((a, b) => a[0].localeCompare(b[0]));
    let exposure = {
      results: tuples.map(t => t[0]).join(","),
      terminal: tuples.map(t => t[1]).join(","),
      sap,
    };
    lazy.logger.debug("Recording exposure event", exposure);
    Glean.urlbar.exposure.record(exposure);

    // Submit the `urlbar-keyword-exposure` ping if any keyword exposure events
    // were recorded above.
    if (keywordExposureRecorded) {
      GleanPings.urlbarKeywordExposure.submit();
    }
  }

  /**
   * Registers an exposure for a result in the current urlbar session, if the
   * result should record exposure telemetry. All exposures that are added
   * during a session are recorded in the `exposure` event at the end of the
   * session. If keyword exposures are enabled, they will be recorded in the
   * `urlbar-keyword-exposure` ping at the end of the session as well. Exposures
   * are cleared at the end of each session and do not carry over.
   *
   * @param {UrlbarResult} result An exposure will be added for this result if
   *        exposures are enabled for its result type.
   * @param {UrlbarQueryContext} queryContext The query context associated with
   *        the result.
   */
  addExposure(result, queryContext) {
    if (result.exposureTelemetry) {
      this.#addExposureInternal(result, queryContext);
    }
  }

  /**
   * Registers a tentative exposure for a result in the current urlbar session.
   * Exposures that remain tentative at the end of the session are discarded and
   * are not recorded in the exposure event.
   *
   * @param {UrlbarResult} result A tentative exposure will be added for this
   *        result if exposures are enabled for its result type.
   * @param {UrlbarQueryContext} queryContext The query context associated with
   *        the result.
   */
  addTentativeExposure(result, queryContext) {
    if (result.exposureTelemetry) {
      this.#tentativeExposures.push({
        weakResult: Cu.getWeakReference(result),
        weakQueryContext: Cu.getWeakReference(queryContext),
      });
    }
  }

  /**
   * Converts all tentative exposures that were added and not yet discarded
   * during the current urlbar session into actual exposures that will be
   * recorded at the end of the session.
   */
  acceptTentativeExposures() {
    if (this.#tentativeExposures.length) {
      for (let { weakResult, weakQueryContext } of this.#tentativeExposures) {
        let result = weakResult.get();
        let queryContext = weakQueryContext.get();
        if (result && queryContext) {
          this.#addExposureInternal(result, queryContext);
        }
      }
      this.#tentativeExposures = [];
    }
  }

  /**
   * Discards all tentative exposures that were added and not yet accepted
   * during the current urlbar session.
   */
  discardTentativeExposures() {
    if (this.#tentativeExposures.length) {
      this.#tentativeExposures = [];
    }
  }

  #addExposureInternal(result, queryContext) {
    // If we haven't added an exposure for this result, add it now. The view can
    // add exposures for the same results again and again due to the nature of
    // its update process, but we should record at most one exposure per result.
    if (!this.#exposureResults.has(result)) {
      this.#exposureResults.add(result);
      let resultType = lazy.UrlbarUtils.searchEngagementTelemetryType(result);
      this.#exposures.push({
        resultType,
        weakResult: Cu.getWeakReference(result),
        keyword:
          !queryContext.isPrivate &&
          lazy.UrlbarPrefs.get("keywordExposureResults").has(resultType)
            ? queryContext.trimmedLowerCaseSearchString
            : null,
      });
    }
  }

  #getInteractionType(
    method,
    startEventInfo,
    searchSource,
    searchWords,
    searchMode
  ) {
    if (searchMode?.entry === "topsites_newtab") {
      return "topsite_search";
    }

    let interaction = startEventInfo.interactionType;
    if (
      (interaction === "returned" || interaction === "restarted") &&
      this._isRefined(new Set(searchWords), this.#previousSearchWordsSet)
    ) {
      interaction = "refined";
    }

    if (searchSource === "urlbar_persisted") {
      switch (interaction) {
        case "returned": {
          interaction = "persisted_search_terms";
          break;
        }
        case "restarted":
        case "refined": {
          interaction = `persisted_search_terms_${interaction}`;
          break;
        }
      }
    }

    if (
      (method === "engagement" &&
        lazy.UrlbarPrefs.isPersistedSearchTermsEnabled()) ||
      method === "abandonment"
    ) {
      this.#previousSearchWordsSet = new Set(searchWords);
    } else if (method === "engagement") {
      this.#previousSearchWordsSet = null;
    }

    return interaction;
  }

  #getSearchMode(searchMode) {
    if (!searchMode) {
      return "";
    }

    if (searchMode.engineName) {
      return "search_engine";
    }

    const source = lazy.UrlbarUtils.LOCAL_SEARCH_MODES.find(
      m => m.source == searchMode.source
    )?.telemetryLabel;
    return source ?? "unknown";
  }

  /**
   * Checks whether re-searched by modifying some of the keywords from the
   * previous search. Concretely, returns true if there is intersects between
   * both keywords, otherwise returns false. Also, returns false even if both
   * are the same.
   *
   * @param {Set} currentSet The current keywords.
   * @param {Set} [previousSet] The previous keywords.
   * @returns {boolean} true if current searching are refined.
   */
  _isRefined(currentSet, previousSet = null) {
    if (!previousSet) {
      return false;
    }

    const intersect = (setA, setB) => {
      let count = 0;
      for (const word of setA.values()) {
        if (setB.has(word)) {
          count += 1;
        }
      }
      return count > 0 && count != setA.size;
    };

    return (
      intersect(currentSet, previousSet) || intersect(previousSet, currentSet)
    );
  }

  /**
   * Resets the currently tracked user-generated event that was registered via
   * start(), so it won't be recorded.  If there's no tracked event, this is a
   * no-op.
   */
  discard() {
    if (this._startEventInfo) {
      this._startEventInfo = null;
      this._discarded = true;
    }
  }

  /**
   * Reset the internal state. This function is used for only when testing.
   */
  reset() {
    this.#previousSearchWordsSet = null;
  }

  /**
   * Prefs to record in telemetry.
   *
   * If a pref is a `fallbackPref` for a Nimbus variable, list the variable
   * instead of the pref. That way, the metric will record the variable value
   * when the variable is defined and the pref value otherwise.
   */
  #PING_PREFS = {
    maxRichResults: Glean.urlbar.prefMaxResults,
    quickSuggestOnlineAvailable: Glean.urlbar.prefSuggestOnlineAvailable,
    "quicksuggest.online.enabled": Glean.urlbar.prefSuggestOnlineEnabled,
    "suggest.quicksuggest.all": Glean.urlbar.prefSuggestAll,
    "suggest.quicksuggest.sponsored": Glean.urlbar.prefSuggestSponsored,
    "suggest.topsites": Glean.urlbar.prefSuggestTopsites,
  };

  #readPingPrefs() {
    for (const p of Object.keys(this.#PING_PREFS)) {
      this.#recordPref(p);
    }
  }

  #recordPref(pref) {
    const metric = this.#PING_PREFS[pref];
    if (metric) {
      metric.set(lazy.UrlbarPrefs.get(pref));
    }

    switch (pref) {
      case "suggest.quicksuggest.all":
      case "suggest.quicksuggest.sponsored":
      case "quicksuggest.enabled":
        if (!lazy.UrlbarPrefs.get(pref)) {
          this.handleDisableSuggest();
        }
        break;
    }
  }

  onPrefChanged(pref) {
    this.#recordPref(pref);
  }

  onNimbusChanged(variable) {
    this.#recordPref(variable);
  }

  // Used to avoid re-entering `record()`.
  #handlingRecord = false;

  #previousSearchWordsSet = null;

  // These properties are used to record exposure telemetry. For general info on
  // exposures, see [1]. For keyword exposures, see [2] and [3]. Here's a
  // summary of how a result flows through the exposure telemetry code path:
  //
  // 1. The view makes the result's row visible and calls `addExposure()` for
  //    it. (Or, if the result is a hidden exposure, the view would have made
  //    its row visible.)
  // 2. If exposure telemetry should be recorded for the result, we push its
  //    telemetry type and some other data onto `#exposures`. If keyword
  //    exposures are enabled, we also include the search string in the data. We
  //    use `#exposureResults` to efficiently make sure we add at most one
  //    exposure per result to `#exposures`.
  // 3. At the end of a session, we record a single `exposure` event that
  //    includes all unique telemetry types in the `#exposures` data. We also
  //    record one `keyword_exposure` event per search string in the data, with
  //    each search string recorded as the `keyword` for that exposure. We clear
  //    `#exposures` so that the data does not carry over into the next session.
  //
  // `#tentativeExposures` supports hidden exposures and is necessary due to how
  // the view updates itself. When the view creates a row for a normal result,
  // the row can start out hidden, and it's only unhidden if the query finishes
  // without being canceled. When the view encounters a hidden-exposure result,
  // it doesn't actually create a row for it, but if the hypothetical row would
  // have started out visible, the view will call `addExposure()`. If the
  // hypothetical row would have started out hidden, the view will call
  // `addTentativeExposure()` and we'll add the result to `#tentativeExposures`.
  // Once the query finishes and the view unhides its rows, it will call
  // `acceptTentativeExposures()`, finally registering exposures for all such
  // hidden-exposure results in the query. If instead the query is canceled, the
  // view will remove its hidden rows and call `discardTentativeExposures()`.
  //
  // [1] https://dictionary.telemetry.mozilla.org/apps/firefox_desktop/metrics/urlbar_exposure
  // [2] https://dictionary.telemetry.mozilla.org/apps/firefox_desktop/pings/urlbar-keyword-exposure
  // [3] https://dictionary.telemetry.mozilla.org/apps/firefox_desktop/metrics/urlbar_keyword_exposure
  #exposures = [];
  #tentativeExposures = [];
  #exposureResults = new WeakSet();

  /**
   * Start tracking a potential disable suggest event after user has seen a
   * suggest result.
   *
   * @param {event} event
   *   A DOM event.
   * @param {InternalActionDetails} details
   *   An object describing interaction details.
   */
  startTrackingDisableSuggest(event, details) {
    // Capture the visible results now so the deferred recording indexes the
    // same set as the tracked selIndex, not the live view's at trigger time.
    details.visibleResults = this.#engagementData.visibleResults;
    this._lastSearchDetailsForDisableSuggestTracking = {
      // The time when a user interacts a suggest result, either through
      // an engagement or an abandonment.
      interactionTime: this.getCurrentTime(),
      event,
      details,
    };
  }

  handleDisableSuggest() {
    let state = this._lastSearchDetailsForDisableSuggestTracking;
    if (
      !state ||
      this.getCurrentTime() - state.interactionTime >
        lazy.UrlbarPrefs.get("events.disableSuggest.maxSecondsFromLastSearch") *
          1000
    ) {
      this._lastSearchDetailsForDisableSuggestTracking = null;
      return;
    }

    let event = state.event;
    let details = state.details;

    let startEventInfo = {
      interactionType: lazy.UrlbarTelemetryUtils.startInteractionType(
        event,
        details.searchString
      ),
      searchString: details.searchString,
    };

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

    let action = lazy.UrlbarTelemetryUtils.actionFromEvent(
      event,
      details,
      startEventInfo.interactionType
    );

    let { numChars, numWords, searchWords } =
      lazy.UrlbarTelemetryUtils.parseSearchString(details.searchString);

    this.#recordSearchEngagementTelemetry("disable", startEventInfo, {
      action,
      numChars,
      numWords,
      searchWords,
      provider: details.provider,
      searchSource: details.searchSource,
      searchMode: details.searchMode,
      selIndex: details.selIndex,
      visibleResults: details.visibleResults,
      selType: details.selType,
      location: details.location,
      windowMode: details.windowMode,
      ...this.#getOptionalSmartbarTelemetry(details.searchSource),
    });

    this._lastSearchDetailsForDisableSuggestTracking = null;
  }

  getCurrentTime() {
    return ChromeUtils.now();
  }

  /**
   * Start tracking a potential bounce event after the user has engaged
   * with a URL bar result.
   *
   * @param {object} browser
   *   The browser object.
   * @param {event} event
   *   A DOM event.
   * @param {ActionDetails} details
   *   An object describing interaction details.
   */
  async startTrackingBounceEvent(browser, event, details) {
    let state = this._controller.input.getBrowserState(browser);
    let startEventInfo = this._startEventInfo;

    // If we are already tracking a bounce, then another engagement
    // could possibly lead to a bounce.
    if (state.bounceEventTracking) {
      await this.handleBounceEventTrigger(browser);
    }

    // Capture the visible results now so the deferred recording indexes the
    // same set as the tracked selIndex, not the live view's at trigger time.
    details.visibleResults = this.#engagementData.visibleResults;

    state.bounceEventTracking = {
      startTime: Date.now(),
      pickEvent: event,
      resultDetails: details,
      startEventInfo,
    };
  }

  /**
   * Handle a bounce event trigger.
   * These include closing the tab/window and navigating away via
   * browser chrome (this includes clicking on history or bookmark entries,
   * and engaging with the URL bar).
   *
   * @param {object} browser
   *   The browser object.
   */
  async handleBounceEventTrigger(browser) {
    let state = this._controller.input.getBrowserState(browser);
    if (state.bounceEventTracking) {
      const interactions =
        (await lazy.Interactions.getRecentInteractionsForBrowser(browser)) ??
        [];

      // handleBounceEventTrigger() can run concurrently, so we bail out
      // if a prior async invocation has already cleared bounceEventTracking.
      if (!state.bounceEventTracking) {
        return;
      }

      let totalViewTime = 0;
      for (let interaction of interactions) {
        if (interaction.created_at >= state.bounceEventTracking.startTime) {
          totalViewTime += interaction.totalViewTime || 0;
        }
      }

      // If the total view time when the user navigates away after a
      // URL bar interaction is less than the threshold of
      // events.bounce.maxSecondsFromLastSearch, we record a bounce event.
      // If totalViewTime is 0, that means the page didn't load yet, so
      // we wouldn't record a bounce event.
      if (
        totalViewTime != 0 &&
        totalViewTime <
          lazy.UrlbarPrefs.get("events.bounce.maxSecondsFromLastSearch") * 1000
      ) {
        this.recordBounceEvent(browser, totalViewTime);
      }

      state.bounceEventTracking = null;
    }
  }

  /**
   * Record a bounce event
   *
   * @param {object} browser
   *   The browser object.
   * @param {number} viewTime
   *  The time spent on a tab after a URL bar engagement before
   *  navigating away via browser chrome or closing the tab.
   */
  recordBounceEvent(browser, viewTime) {
    let state = this._controller.input.getBrowserState(browser);
    let event = state.bounceEventTracking.pickEvent;
    let details = state.bounceEventTracking.resultDetails;

    let startEventInfo = state.bounceEventTracking.startEventInfo;

    if (!startEventInfo) {
      return;
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

    let action = lazy.UrlbarTelemetryUtils.actionFromEvent(
      event,
      details,
      startEventInfo.interactionType
    );

    let { numChars, numWords, searchWords } =
      lazy.UrlbarTelemetryUtils.parseSearchString(details.searchString);

    details.provider = details.result?.providerName;
    details.selIndex = details.result?.rowIndex ?? -1;

    this.#recordSearchEngagementTelemetry("bounce", startEventInfo, {
      action,
      numChars,
      numWords,
      searchWords,
      provider: details.provider,
      searchSource: details.searchSource,
      searchMode: details.searchMode,
      selIndex: details.selIndex,
      visibleResults: details.visibleResults,
      selType: details.selType,
      viewTime: viewTime / 1000,
      location: details.location,
      windowMode: details.windowMode,
      ...this.#getOptionalSmartbarTelemetry(details.searchSource),
    });
  }
}
