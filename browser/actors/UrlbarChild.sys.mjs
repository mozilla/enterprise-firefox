/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  UrlbarParentControllerProxy:
    "moz-src:///browser/components/urlbar/UrlbarParentControllerProxy.sys.mjs",
  UrlbarPrefs: "moz-src:///browser/components/urlbar/UrlbarPrefs.sys.mjs",
  UrlbarQueryContext:
    "moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs",
});

/**
 * @import {UrlbarParent} from "./UrlbarParent.sys.mjs"
 * @import {UrlbarParentController} from "moz-src:///browser/components/urlbar/UrlbarParentController.sys.mjs"
 * @import {UrlbarChildController} from "chrome://browser/content/urlbar/UrlbarChildController.mjs"
 */

/**
 * Child-process counterpart of `UrlbarParent`. Each `UrlbarChildController`
 * created by a `<moz-urlbar>` instance asks this actor for the object that
 * runs the query lifecycle and parent-only telemetry on its behalf.
 *
 * Two transports back that object:
 * - Direct (default for chrome `<moz-urlbar>`): both actors live in the parent
 *   process, so we hand the real `UrlbarParentController` reference back and
 *   methods are invoked synchronously in-process.
 * - Message-passing: used for a content-process `<moz-urlbar>` (e.g.
 *   about:newtab), and for chrome when
 *   `browser.urlbar.ipc.chromeMessagePassing` is set (so the wire path runs in
 *   CI). We hand back a `UrlbarParentControllerProxy` that trades messages with
 *   the parent-side controller, identified by an `instanceId`. The parent's
 *   `Notify` messages are dispatched back to the paired child controller, which
 *   we hold weakly (keyed by `instanceId`) so as not to pin its input.
 *
 * On the message path the parent retains its controller strongly (keyed by
 * `instanceId`), so we tie that controller's lifetime to the input: the input
 * is registered in a `FinalizationRegistry` that sends `Destroy(instanceId)`
 * when the input is collected, letting the parent drop its entry. (The direct
 * path needs none of this: its controllers are cached in a `WeakMap` keyed by
 * the input.)
 */
export class UrlbarChild extends JSWindowActorChild {
  #nextInstanceId = 0;

  /** @type {Map<number, WeakRef<UrlbarChildController>>} */
  #childControllers = new Map();

  // Sends `Destroy(instanceId)` to the parent once a message-path input is
  // collected, so the parent can drop the controller it holds for it.
  #destroyRegistry = new FinalizationRegistry(instanceId => {
    this.#childControllers.delete(instanceId);
    try {
      this.sendAsyncMessage("Destroy", { instanceId });
    } catch (ex) {
      // The actor is already gone (e.g. the window global was torn down), so
      // the parent's controllers went with it; nothing left to clean up.
    }
  });

  /**
   * Returns the object that backs a given `<moz-urlbar>` input's child
   * controller, creating it on demand. On the direct path, reconnecting the
   * same element returns the existing controller.
   *
   * @param {object} input
   *   The `UrlbarInput`/`SmartbarInput` that owns the child controller.
   * @returns {UrlbarParentController} The real controller (direct path) or, on
   *   the message path, a `UrlbarParentControllerProxy` that stands in for one.
   */
  getOrCreateController(input) {
    let parentActor = this.#parentActor;
    // In-process and not forcing the wire path: hand back the real controller.
    if (parentActor && !lazy.UrlbarPrefs.get("ipc.chromeMessagePassing")) {
      return parentActor.getOrCreateController(input);
    }
    // Message-passing path: cross-process, or chrome with the pref on.
    let instanceId = ++this.#nextInstanceId;
    this.#destroyRegistry.register(input, instanceId);
    // The proxy duck-types as a UrlbarParentController for the child controller.
    return /** @type {UrlbarParentController} */ (
      /** @type {unknown} */ (
        new lazy.UrlbarParentControllerProxy(this, instanceId, {
          sapName: input.sapName,
          isPrivate: input.isPrivate,
        })
      )
    );
  }

  /**
   * Records the message-path child controller for an instance so the parent's
   * `Notify` messages can be dispatched to it. Held weakly so it (and its
   * input) stay collectable.
   *
   * @param {number} instanceId
   *   The instance the controller was created for.
   * @param {UrlbarChildController} child
   *   The paired child controller.
   */
  registerChildController(instanceId, child) {
    this.#childControllers.set(instanceId, new WeakRef(child));
  }

  receiveMessage(message) {
    if (message.name != "Notify") {
      return;
    }
    let { instanceId, name, params, resultViewData } = message.data;
    let child = this.#childControllers.get(instanceId)?.deref();
    if (!child) {
      this.#childControllers.delete(instanceId);
      return;
    }
    let deserialized = params.map(param =>
      param?.serializedQueryContext
        ? lazy.UrlbarQueryContext.fromWire(param.serializedQueryContext)
        : param
    );
    // The parent ran the query but the input lives here, so let it react to the
    // first result (search mode, autofill) before the results are shown. If it
    // takes over (returns true), the results are stale; don't dispatch them.
    if (name == "onQueryResults") {
      let queryContext = deserialized[0];
      if (
        queryContext.firstResultChanged &&
        child.input.onFirstResult(queryContext.results[0])
      ) {
        return;
      }
    }
    if (resultViewData) {
      // params[0] is the query context; reattach the per-result view data the
      // parent pre-fetched so the view can read it synchronously.
      deserialized[0].results.forEach((result, i) => {
        result.viewData = resultViewData[i];
      });
    }
    child.notify(name, ...deserialized);
  }

  /**
   * In the parent process: the parent actor
   * In a child process: undefined
   *
   * @type {UrlbarParent | undefined}
   */
  get #parentActor() {
    return this.manager.parentActor?.getActor("Urlbar");
  }
}
