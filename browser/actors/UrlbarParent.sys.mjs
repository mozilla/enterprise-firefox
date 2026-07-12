/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  UrlbarParentController:
    "moz-src:///browser/components/urlbar/UrlbarParentController.sys.mjs",
  UrlbarQueryContext:
    "moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs",
  UrlbarResult: "chrome://browser/content/urlbar/UrlbarResult.mjs",
  UrlbarShared: "chrome://browser/content/urlbar/UrlbarShared.mjs",
});

/**
 * @import {UrlbarParentController} from "moz-src:///browser/components/urlbar/UrlbarParentController.sys.mjs"
 */

/**
 * Parent-process counterpart of `UrlbarChild`. Owns the
 * `UrlbarParentController` instances created for the `<moz-urlbar>`
 * elements served by this window global, across both transports:
 *
 * - Direct path (chrome `<moz-urlbar>`, default): `getOrCreateController`
 *   hands the real `UrlbarParentController` back to the in-process child,
 *   cached in a `WeakMap` keyed by the input element so a controller's
 *   lifetime tracks its element rather than the actor's. Reconnecting the
 *   same element (e.g. toggling customize mode) reuses the same controller.
 *
 * - Message path (content-process `<moz-urlbar>`, or chrome with
 *   `browser.urlbar.ipc.chromeMessagePassing`): the child holds a
 *   `UrlbarParentControllerProxy` and trades actor messages with us. We build
 *   the controller from the `Init` payload and retain it in a `Map` keyed by
 *   the child-assigned `instanceId`, routing subsequent messages to it. The
 *   controller's notifications go back to the child as `Notify` messages
 *   (dispatched through a parent-side `UrlbarChildControllerProxy` stand-in).
 *   The controller is dropped on the `Destroy` message the child sends when its
 *   input is collected (via a `FinalizationRegistry`).
 */
export class UrlbarParent extends JSWindowActorParent {
  /** @type {WeakMap<object, UrlbarParentController>} */
  #controllers = new WeakMap();

  /** @type {Map<number, UrlbarParentController>} */
  #messageControllers = new Map();

  /**
   * Direct path only: returns the in-process controller for an input,
   * creating it on demand.
   *
   * @param {object} input
   *   The `UrlbarInput`/`SmartbarInput` owning the controller.
   * @returns {UrlbarParentController}
   */
  getOrCreateController(input) {
    let controller = this.#controllers.get(input);
    if (!controller) {
      controller = new lazy.UrlbarParentController({
        sapName: input.sapName,
        isPrivate: input.isPrivate,
      });
      this.#controllers.set(input, controller);
    }
    return controller;
  }

  /**
   * Message path: routes child->parent messages to the controller identified
   * by `instanceId`, deserializing their payloads.
   *
   * @param {object} message
   *   The actor message, with `name` and `data`.
   */
  receiveMessage(message) {
    let { instanceId } = message.data;

    if (message.name == "Init") {
      let { sapName, isPrivate } = message.data;
      let controller = new lazy.UrlbarParentController({ sapName, isPrivate });
      // The real child controller lives across the boundary, so hand the
      // parent controller a proxy that forwards its notifications over the
      // actor.
      controller.setChild(
        new UrlbarChildControllerProxy(this, instanceId, controller)
      );
      this.#messageControllers.set(instanceId, controller);
      return undefined;
    }

    if (message.name == "Destroy") {
      this.#messageControllers.delete(instanceId);
      return undefined;
    }

    let controller = this.#messageControllers.get(instanceId);
    if (!controller) {
      return undefined;
    }

    switch (message.name) {
      case "GetViewUpdate":
        return controller.getViewUpdate(
          lazy.UrlbarResult.fromWire(message.data.result),
          message.data.idsByName
        );
      case "GetHeuristicResult":
        return controller
          .getHeuristicResult(
            lazy.UrlbarQueryContext.fromWire(message.data.queryContext)
          )
          .then(result => result?.toWire() ?? null);
      case "StartQuery":
        // Round-trips so the proxy's startQuery resolves at true completion with
        // the finished context. The context's results keep their data in private
        // fields, so reduce it to wire form like the QUERY_RESULTS notifications.
        return controller
          .startQuery(
            lazy.UrlbarQueryContext.fromWire(message.data.queryContext)
          )
          .then(context => context.toWire());
      case "CancelQuery":
        controller.cancelQuery();
        break;
      case "RemoveResult":
        controller.removeResult(
          lazy.UrlbarResult.fromWire(message.data.result)
        );
        break;
      case "SetLastQueryContextCache":
        controller.setLastQueryContextCache(
          lazy.UrlbarQueryContext.fromWire(message.data.queryContext)
        );
        break;
      case "ClearLastQueryContextCache":
        controller.clearLastQueryContextCache();
        break;
      // onBeforeSelection/onSelection drop their second argument (the selected
      // DOM element), which can't cross the boundary. Only
      // UrlbarProviderQuickSuggestContextualOptIn reads it, and it isn't active
      // on the message path. Bug 2052166 removes the parameter with that
      // provider.
      case "OnBeforeSelection":
        controller.onBeforeSelection(
          lazy.UrlbarResult.fromWire(message.data.result)
        );
        break;
      case "OnSelection":
        controller.onSelection(lazy.UrlbarResult.fromWire(message.data.result));
        break;
    }
    return undefined;
  }
}

/**
 * Parent-side stand-in for the `UrlbarChildController`, mirroring
 * `UrlbarParentControllerProxy` on the content side. The parent controller
 * calls `notify()` here, and we forward each notification to the real child
 * controller across the boundary as a `Notify` message, serializing any
 * `UrlbarQueryContext` argument.
 */
class UrlbarChildControllerProxy {
  /** @type {UrlbarParent} */
  #actor;

  /** @type {number} */
  #instanceId;

  /** @type {UrlbarParentController} */
  #controller;

  constructor(actor, instanceId, controller) {
    this.#actor = actor;
    this.#instanceId = instanceId;
    this.#controller = controller;
  }

  notify(name, ...params) {
    let data = {
      instanceId: this.#instanceId,
      name,
      params: params.map(param =>
        param instanceof lazy.UrlbarQueryContext
          ? { serializedQueryContext: param.toWire() }
          : param
      ),
    };
    // The view fetches a result's template and menu commands synchronously,
    // which can't cross the boundary on demand, so pre-fetch them here for the
    // results we're about to deliver and ship them alongside.
    if (name == lazy.UrlbarShared.NOTIFICATIONS.QUERY_RESULTS) {
      let queryContext = params[0];
      data.resultViewData = queryContext.results.map(result => ({
        viewTemplate:
          result.type == lazy.UrlbarShared.RESULT_TYPE.DYNAMIC
            ? this.#controller.getViewTemplate(result)
            : undefined,
        resultCommands: this.#controller.getResultCommands(
          result,
          queryContext.isPrivate
        ),
      }));
    }
    this.#actor.sendAsyncMessage("Notify", data);
  }
}
