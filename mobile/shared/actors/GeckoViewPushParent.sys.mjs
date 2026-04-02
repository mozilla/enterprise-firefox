/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  EventDispatcher: "resource://gre/modules/Messaging.sys.mjs",
});

export class GeckoViewPushParent extends JSProcessActorParent {
  receiveMessage(aMessage) {
    const { data, name } = aMessage;

    switch (name) {
      case "GeckoView:PushSubscribe": {
        return lazy.EventDispatcher.instance.sendRequestForResult({
          ...data,
          type: "GeckoView:PushSubscribe",
        });
      }

      case "GeckoView:PushUnsubscribe": {
        return lazy.EventDispatcher.instance.sendRequestForResult({
          ...data,
          type: "GeckoView:PushUnsubscribe",
        });
      }

      case "GeckoView:PushGetSubscription": {
        return lazy.EventDispatcher.instance.sendRequestForResult({
          ...data,
          type: "GeckoView:PushGetSubscription",
        });
      }

      default: {
        super.receiveMessage(aMessage);
      }
    }

    return undefined;
  }
}
