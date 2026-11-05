/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  createEnterpriseLogger:
    "moz-src:///toolkit/components/enterprise/modules/EnterpriseCommon.sys.mjs",
  FeltErrorReport: "moz-src:///toolkit/components/felt/FeltErrorReport.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  return lazy.createEnterpriseLogger("FeltErrorWindowParent");
});

/**
 * Parent-side of the Felt error window actor to collect the error page URL. It
 * receives the URL of the loaded error page and forwards that to the error
 * report component.
 */
export class FeltErrorWindowParent extends JSWindowActorParent {
  receiveMessage(message) {
    lazy.log.debug(
      `Received message ${message.name} => ${JSON.stringify(message.data)}`
    );
    switch (message.name) {
      case "ErrorReport": {
        const errorPage = message.data;
        lazy.FeltErrorReport.handleNetError(errorPage).catch(err =>
          lazy.log.error(`Error while handling ErrorReport message: ${err}`)
        );
        break;
      }
    }
  }
}
