/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  UrlbarQueryContext:
    "moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs",
  UrlbarResult: "chrome://browser/content/urlbar/UrlbarResult.mjs",
});

/**
 * @import {UrlbarChild} from "../../actors/UrlbarChild.sys.mjs"
 */

/**
 * Stand-in for a `UrlbarParentController` on the Urlbar actor's
 * message-passing path. A `UrlbarChildController` whose `<moz-urlbar>` runs in
 * a content process (or in chrome with
 * `browser.urlbar.ipc.chromeMessagePassing`) holds one of these instead of a
 * direct controller reference: it forwards the child->parent query-lifecycle
 * calls to the parent process as actor messages, where `UrlbarParent` routes
 * them to the real controller keyed by `instanceId`. Parent->child
 * notifications come back as `Notify` messages that the child actor dispatches
 * to the paired `UrlbarChildController`.
 *
 * The view's synchronous per-result data (`getViewTemplate`/`getResultCommands`)
 * can't be fetched across the boundary on demand, so it's pre-fetched with each
 * `QueryResults` and read back here from the result. Telemetry is wired up in a
 * later patch; until then this path is incomplete and off by default.
 */
export class UrlbarParentControllerProxy {
  /** @type {UrlbarChild} */
  #actor;

  /** @type {number} */
  #instanceId;

  // The last query context, mirrored locally so the content side can read it
  // (e.g. for key navigation and dismissals) without a round-trip. The parent
  // controller keeps its own; the relevant set/clear points are forwarded here.
  #lastQueryContextWrapper = null;

  /**
   * @param {UrlbarChild} actor
   *   The child actor used to message the parent process.
   * @param {number} instanceId
   *   Identifies the paired parent-side controller in `UrlbarParent`'s map.
   * @param {object} options
   *   The data the parent controller is constructed from.
   * @param {string} options.sapName
   *   The search access point name.
   * @param {boolean} options.isPrivate
   *   Whether the controller serves a private-browsing input.
   */
  constructor(actor, instanceId, { sapName, isPrivate }) {
    this.#actor = actor;
    this.#instanceId = instanceId;
    this.#actor.sendAsyncMessage("Init", { instanceId, sapName, isPrivate });
  }

  /**
   * Registers the paired child controller with the actor so parent->child
   * `Notify` messages for this instance can be dispatched to it. The parent
   * controller itself never holds the child on this path (cross-process it
   * can't, and a strong ref would pin the input and defeat cleanup).
   *
   * @param {object} child
   *   The paired `UrlbarChildController`.
   */
  setChild(child) {
    this.#actor.registerChildController(this.#instanceId, child);
  }

  // Named to match the controller property the child controller forwards to.
  get _lastQueryContextWrapper() {
    return this.#lastQueryContextWrapper;
  }

  /**
   * Starts a query parent-side and resolves when it finishes, mirroring the
   * real controller's `Promise<UrlbarQueryContext>` contract. Callers store the
   * promise as `lastQueryContextPromise` to await search completion, so it must
   * resolve at true completion (not when the message is sent) and with the
   * final, results-bearing context.
   *
   * @param {UrlbarQueryContext} queryContext The query context to run.
   * @returns {Promise<UrlbarQueryContext>} The finished query context.
   */
  startQuery(queryContext) {
    this.#lastQueryContextWrapper = { queryContext };
    return this.#actor
      .sendQuery("StartQuery", {
        instanceId: this.#instanceId,
        queryContext: queryContext.toWire(),
      })
      .then(wire => lazy.UrlbarQueryContext.fromWire(wire));
  }

  /**
   * Runs a one-off query parent-side and returns its heuristic result. Async on
   * the caller's side already, so it round-trips through the parent.
   *
   * @param {object} queryContext The query context to run.
   * @returns {Promise<?object>} The heuristic result, or null.
   */
  async getHeuristicResult(queryContext) {
    let wire = await this.#actor.sendQuery("GetHeuristicResult", {
      instanceId: this.#instanceId,
      queryContext: queryContext.toWire(),
    });
    return wire ? lazy.UrlbarResult.fromWire(wire) : null;
  }

  cancelQuery() {
    this.#actor.sendAsyncMessage("CancelQuery", {
      instanceId: this.#instanceId,
    });
  }

  /**
   * @param {UrlbarResult} result The result to remove.
   */
  removeResult(result) {
    this.#actor.sendAsyncMessage("RemoveResult", {
      instanceId: this.#instanceId,
      result: result.toWire(),
    });
  }

  /**
   * @param {UrlbarQueryContext} queryContext The context to cache.
   */
  setLastQueryContextCache(queryContext) {
    this.#lastQueryContextWrapper = { queryContext };
    this.#actor.sendAsyncMessage("SetLastQueryContextCache", {
      instanceId: this.#instanceId,
      queryContext: queryContext.toWire(),
    });
  }

  clearLastQueryContextCache() {
    this.#lastQueryContextWrapper = null;
    this.#actor.sendAsyncMessage("ClearLastQueryContextCache", {
      instanceId: this.#instanceId,
    });
  }

  /**
   * @param {UrlbarResult} result The result about to be selected.
   */
  onBeforeSelection(result) {
    this.#actor.sendAsyncMessage("OnBeforeSelection", {
      instanceId: this.#instanceId,
      result: result.toWire(),
    });
  }

  /**
   * @param {UrlbarResult} result The selected result.
   */
  onSelection(result) {
    this.#actor.sendAsyncMessage("OnSelection", {
      instanceId: this.#instanceId,
      result: result.toWire(),
    });
  }

  /**
   * Returns a dynamic result's view template, pre-fetched and attached to the
   * result when its `QueryResults` was delivered (see `UrlbarChild`).
   *
   * @param {UrlbarResult} result The dynamic result.
   * @returns {object} The view template.
   */
  getViewTemplate(result) {
    // @ts-expect-error FIXME(bug 2051959): viewData is a message-path expando
    // (see `UrlbarChild`), not declared on UrlbarResult.
    return result.viewData?.viewTemplate;
  }

  /**
   * Returns a result's menu commands, pre-fetched and attached to the result
   * when its `QueryResults` was delivered (see `UrlbarChild`).
   *
   * @param {UrlbarResult} result The result.
   * @returns {?object[]} The commands, or null/undefined.
   */
  getResultCommands(result) {
    // @ts-expect-error FIXME(bug 2051959): viewData is a message-path expando
    // (see `UrlbarChild`), not declared on UrlbarResult.
    return result.viewData?.resultCommands;
  }

  /**
   * Returns a dynamic result's view update. This one is already async on the
   * caller's side, so it round-trips through the parent rather than being
   * pre-fetched.
   *
   * @param {UrlbarResult} result The dynamic result.
   * @param {object} idsByName A map from node names to element ids.
   * @returns {Promise<object>} The view update.
   */
  getViewUpdate(result, idsByName) {
    return this.#actor.sendQuery("GetViewUpdate", {
      instanceId: this.#instanceId,
      result: result.toWire(),
      idsByName,
    });
  }
}
