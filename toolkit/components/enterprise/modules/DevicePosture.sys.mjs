/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
  composeOSNames: "resource://gre/modules/enterprise/EnterpriseOSInfo.sys.mjs",
  createEnterpriseLogger:
    "resource://gre/modules/enterprise/EnterpriseCommon.sys.mjs",
  EdrDetection: "resource://gre/modules/enterprise/EdrDetection.sys.mjs",
  MachineId: "resource://gre/modules/enterprise/MachineId.sys.mjs",
  TelemetryEnvironment: "resource://gre/modules/TelemetryEnvironment.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  return lazy.createEnterpriseLogger("DevicePosture");
});

// XXX: hardcoded for now. The console does not yet expose which EDR agents to
// probe for, so we limit detection to the agents we currently care about.
const EDR_AGENTS_TO_PROBE = ["crowdstrike", "cortex-xdr"];

export const DevicePosture = {
  async getDatabaseForApp({ waitForAddons = false } = {}) {
    lazy.log.debug(`getDatabaseForApp(${waitForAddons})`);

    if (!lazy.AddonManager.isReady) {
      if (waitForAddons) {
        await lazy.AddonManager.readyPromise;
      } else {
        return null;
      }
    }

    return await lazy.AddonManager;
  },

  // AddonManager is only available in the full browser process, not in
  // the FELT login window. Returns null in the FELT UI. When
  // waitForAddons is true (periodic poll), blocks until AddonManager is
  // ready so extensions are always reported. When false (startup),
  // returns null if AddonManager isn't ready yet to avoid blocking.
  async getExtensions({ waitForAddons = false } = {}) {
    lazy.log.debug(`getExtensions(${waitForAddons})`);

    try {
      let addonsDatabase = null;
      if (Services.felt.isFeltUI()) {
        return null;
      }

      if (Services.felt.isFeltBrowser()) {
        addonsDatabase = await this.getDatabaseForApp(waitForAddons);
      }

      return (await addonsDatabase.getAddonsByTypes([
        "extension",
        "sitepermission",
        "siteperm_deprecated",
        "plugin",
        "mlmodel",
      ])).map(addon => ({
        id: addon.id,
        name: addon.name ?? "",
        type: addon.type,
        version: addon.version ?? "",
        enabled: addon.isActive,
      }));
    } catch (ex) {
      lazy.log.error(`Error while getting extensions for device posture`, ex);
      return null;
    }
  },

  /**
   * @typedef {object} DeviceNetwork
   * @property {null} ipv4 IPv4 address, TBD
   * @property {null} ipv6 IPv6 address, TBD
   */

  /**
   * @typedef {object} DeviceAddon
   * @property {string} id Addon identifier.
   * @property {string} name Human-readable display name.
   * @property {string} type Addon type (extension, plugin, sitepermission, etc).
   * @property {string} version Addon version string.
   * @property {boolean} enabled Whether the addon is currently active.
   */

  /**
   * @typedef {object} DeviceMachineId
   * @property {string} id Raw platform machine identifier (e.g. device serial).
   * @property {string|null} source Source tier the identifier was resolved from.
   */

  /**
   * @typedef {object} DeviceEdr
   * @property {string} name EDR agent identifier (e.g. "crowdstrike").
   */

  /**
   * @typedef {object} DevicePosture
   * @property {object} os Telemetry-reported os information.
   * @property {object|undefined} security Telemetry-reported security software info (windows only)
   * @property {object} build Telemetry-reported build info info
   * @property {DeviceNetwork} network Network posture (placeholders for now).
   * @property {DeviceAddon[]|null} extensions Installed browser addons, or null if not yet available.
   * @property {DeviceMachineId|null} machineId Stable machine identifier, or null if unavailable.
   * @property {boolean} secureBootEnabled Whether Secure Boot is enabled.
   * @property {boolean} isDomainJoined Whether the machine is joined to a domain (Windows on-prem AD or Azure AD/Entra).
   * @property {DeviceEdr[]} presentEdrs Detected EDR agents (empty if none).
   */

  /**
   * Collects the device posture from TelemetryEnvironment.currentEnvironment
   * and others data sources.
   *
   * @param {object} [options]
   * @param {boolean} [options.waitForAddons=false] - Whether to block until
   *   AddonManager is ready so extensions are always reported.
   * @returns {Promise<DevicePosture>} devicePosture
   */
  async collect({ waitForAddons = false } = {}) {
    lazy.log.debug(`collect(${waitForAddons})`);
    const getImeiValue = async () => {
      try {
        return await Cc["@mozilla.org/imei/provider;1"]
          .getService()
          .QueryInterface(Ci.nsIImeiProvider).imei;
      } catch {
        return "";
      }
    };

    const getMachineId = async () => {
      try {
        const id = await lazy.MachineId.getRawId();
        if (!id) {
          return null;
        }
        return {
          id,
          source: await lazy.MachineId.getSource(),
        };
      } catch {
        return null;
      }
    };

    const networkInterfaces = Cc["@mozilla.org/network/network-link-service;1"]
      .getService()
      .QueryInterface(Ci.nsINetworkLinkService).networkInterfaces;

    const baseOs = lazy.TelemetryEnvironment.currentEnvironment.system.os;
    const { long: os_long_name, short: os_short_name } =
      await lazy.composeOSNames(baseOs);
    const os = {
      ...baseOs,
      ...(os_long_name != null && { os_long_name }),
      ...(os_short_name != null && { os_short_name }),
    };

    const getPresentEDRs = async () =>
      (await lazy.EdrDetection.getPresentEdrs(EDR_AGENTS_TO_PROBE)).map(
        name => ({ name })
      );

    // These probes are independent, and some are slow (subprocess spawns, addon
    // manager readiness, an `ioreg` shell-out), so run them concurrently rather
    // than serializing the awaits.
    const [mobileEquipmentId, extensions, machineId, presentEdrs] =
      await Promise.all([
        getImeiValue(),
        this.getExtensions(),
        getMachineId(),
        getPresentEDRs(),
      ]);

    const devicePosturePayload = {
      os,
      security: lazy.TelemetryEnvironment.currentEnvironment.system.sec,
      build: lazy.TelemetryEnvironment.currentEnvironment.build,
      network: {
        mobileEquipmentId,
        interfaces: networkInterfaces,
      },
      extensions,
      machineId,
      secureBootEnabled:
        Services.sysinfo.getPropertyAsBool("secureBootEnabled"),
      isDomainJoined: Services.sysinfo.getPropertyAsBool("isDomainJoined"),
      presentEdrs,
    };

    lazy.log.debug(
      `collect(${waitForAddons}): devicePosturePayload:${JSON.stringify(devicePosturePayload)}`
    );
    return devicePosturePayload;
  },
};
