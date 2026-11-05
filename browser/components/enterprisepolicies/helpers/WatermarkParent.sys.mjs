/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * Parent-process side of the Watermark policy. It serves the current watermark
 * configuration to the content-process WatermarkChild actor, which queries it
 * with "Watermark:GetConfig" when it is created. The configuration itself is
 * owned by WatermarkPolicy; pushes on policy changes go through
 * WatermarkPolicy._refreshOpenTabs ("Watermark:Refresh").
 */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  getWatermarkConfig:
    "moz-src:///browser/components/enterprisepolicies/helpers/WatermarkPolicy.sys.mjs",
});

/**
 * Answers the content process's request for the watermark configuration.
 */
export class WatermarkPolicyParent extends JSWindowActorParent {
  /**
   * @param {ReceiveMessageArgument} message
   * @returns {import("./WatermarkPolicy.sys.mjs").WatermarkConfig?}
   */
  receiveMessage(message) {
    if (message.name === "Watermark:GetConfig") {
      return lazy.getWatermarkConfig();
    }
    return undefined;
  }
}
