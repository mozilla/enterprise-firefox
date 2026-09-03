/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  composeOSNames: "resource://gre/modules/enterprise/EnterpriseOSInfo.sys.mjs",
  ConsoleClient: "resource://gre/modules/enterprise/ConsoleClient.sys.mjs",
  createEnterpriseLogger:
    "resource://gre/modules/enterprise/EnterpriseCommon.sys.mjs",
  DiskEncryption: "resource://gre/modules/enterprise/DiskEncryption.sys.mjs",
  EdrDetection: "resource://gre/modules/enterprise/EdrDetection.sys.mjs",
  MachineId: "resource://gre/modules/enterprise/MachineId.sys.mjs",
  setInterval: "resource://gre/modules/Timer.sys.mjs",
  clearInterval: "resource://gre/modules/Timer.sys.mjs",
  TelemetryEnvironment: "resource://gre/modules/TelemetryEnvironment.sys.mjs",
});

// Fallback cadence for posture monitoring if the console config does not
// specify a polling frequency.
const DEFAULT_POSTURE_POLL_MS = 60000;

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  return lazy.createEnterpriseLogger("DevicePosture");
});

// The EDR agents the console asked us to probe for, as a JSON string. Absent,
// empty or malformed means "probe nothing".
export const EDR_AGENTS_PREF = "enterprise.posture.edr_agents";

/** The write side of EDR_AGENTS_PREF. */
export const EdrAgents = {
  /**
   * Writes the console's EDR agent list into this process's EDR_AGENTS_PREF.
   * A missing list writes "[]".
   *
   * @param {string[]} [edrAgents]
   * @returns {string} The value written, so callers can relay it to the other
   *   process.
   */
  write(edrAgents) {
    const serialized = JSON.stringify(edrAgents ?? []);
    Services.prefs.setStringPref(EDR_AGENTS_PREF, serialized);
    return serialized;
  },
};

// Add-on types we report in device posture. This filters extensions.json, which
// only XPIProvider writes to: GMP plugins live in the profile's media.gmp-*
// prefs and ML models in ModelHub's IndexedDB, so both are much trickier to read
// out from outside Firefox and are left unreported for now.
export const REPORTED_ADDON_TYPES = [
  "extension",
  "sitepermission",
  "siteperm_deprecated",
  // "plugin",
  // "mlmodel",
];

// Install locations whose add-ons Firefox keeps running in safe mode, which is
// what XPIProvider's canRunInSafeMode() decides from the location object. What
// is serialized here is its name, so the names are matched instead.
const SAFE_MODE_LOCATIONS = [
  "app-temporary",
  "app-builtin",
  "app-builtin-addons",
  "app-system-addons",
  "app-system-profile",
];

// The locale add-on names are reported in, so the same add-on reads the same in
// the console whatever locale the client runs in.
const REPORTED_ADDON_LOCALE = "en-US";

// The name to report for an add-on serialized in extensions.json: its
// REPORTED_ADDON_LOCALE name when it ships one, its own default locale otherwise.
function reportedAddonName(addon) {
  const locales = Array.isArray(addon.locales) ? addon.locales : [];
  const bestLocale = Services.locale.negotiateLanguages(
    [REPORTED_ADDON_LOCALE],
    locales.flatMap(locale => locale.locales ?? []),
    "und",
    Services.locale.langNegStrategyLookup
  )[0];
  const selected =
    bestLocale === "und"
      ? addon.defaultLocale
      : locales.find(locale => locale.locales?.includes(bestLocale));
  return selected?.name ?? addon.defaultLocale?.name ?? "";
}

export const DevicePosture = {
  /**
   * Reads the add-ons of the profile that is about to launch, for use from the
   * Felt login/launcher process.
   *
   * Felt runs its own AddonManager against its own profile, so this parses the
   * target profile's extensions.json and nothing else: it opens no database and
   * never writes to the profile it reads. It reports the entries XPIDatabase
   * considers visible, the name in REPORTED_ADDON_LOCALE, and what
   * AddonWrapper.isActive would report for the browser being launched.
   *
   * @param {string} profileDir - Absolute path to the target profile directory.
   * @param {object} [options]
   * @param {boolean} [options.safeMode] - Whether the browser reported for runs
   *   in safe mode, which deactivates the add-ons it does not keep running.
   * @returns {Promise<DeviceAddon[]|null>} null when the database cannot be read.
   */
  async readAddonsForFelt(
    profileDir,
    { safeMode = Services.felt.isFeltSafeMode() } = {}
  ) {
    if (!Services.felt.isFeltUI()) {
      throw new Error("readAddonsForFelt() must only be called in Felt");
    }

    const extensionsJson = PathUtils.join(profileDir, "extensions.json");
    lazy.log.debug(`readAddonsForFelt(): ${extensionsJson}`);

    let database;
    try {
      database = await IOUtils.readJSON(extensionsJson);
    } catch (e) {
      if (DOMException.isInstance(e) && e.name === "NotFoundError") {
        // A profile that has never been launched has no database yet.
        lazy.log.debug(`No add-on database at ${extensionsJson}`);
      } else {
        lazy.log.error(`Could not read ${extensionsJson}:`, e);
      }
      return null;
    }

    if (!Array.isArray(database?.addons)) {
      lazy.log.error(`No add-on list in ${extensionsJson}`);
      return null;
    }

    return database.addons
      .filter(
        addon => addon.visible && REPORTED_ADDON_TYPES.includes(addon.type)
      )
      .map(addon => ({
        id: addon.id,
        name: reportedAddonName(addon),
        type: addon.type,
        version: addon.version ?? "",
        enabled:
          !!addon.active &&
          (!safeMode || SAFE_MODE_LOCATIONS.includes(addon.location)),
      }));
  },

  /**
   * Reads the installed add-ons for device posture, from the on-disk database of
   * the profile Felt is reporting for. Returns null when the list cannot be
   * determined.
   *
   * @param {object} [options]
   * @param {string|null} [options.profileDir=null]
   * @returns {Promise<DeviceAddon[]|null>}
   */
  async getExtensions({ profileDir = null } = {}) {
    try {
      // The profile (and thus its extension list) is only known once SSO has
      // resolved the user id; without it we cannot report extensions.
      if (!profileDir) {
        return null;
      }
      return await this.readAddonsForFelt(profileDir);
    } catch (ex) {
      lazy.log.error("Error while getting extensions for device posture", ex);
      return null;
    }
  },

  /**
   * @typedef {object} DeviceNetwork
   * @property {string} mobileEquipmentId IMEI when available, else "".
   * @property {any} interfaces Network interfaces from nsINetworkLinkService.
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
   * @typedef {object} DeviceDiskEncryption
   * @property {"full"|"enabled"|"partial"|"disabled"|"in-progress"|"unknown"} status
   *   Aggregated encryption status.
   * @property {"filevault"|"bitlocker"|"dm-crypt"|"zfs"|null} method
   *   Platform mechanism checked, or null for an unknown status.
   */

  /**
   * @typedef {object} DevicePosture
   * @property {object} os Telemetry-reported os information.
   * @property {object|undefined} security Telemetry-reported security software info (windows only)
   * @property {object} build Telemetry-reported build info info
   * @property {DeviceNetwork} network Network posture.
   * @property {DeviceAddon[]|null} extensions Installed browser addons, or null if not yet available.
   * @property {DeviceMachineId|null} machineId Stable machine identifier, or null if unavailable.
   * @property {boolean} secureBootEnabled Whether Secure Boot is enabled.
   * @property {boolean} isDomainJoined Whether the machine is joined to a domain (Windows on-prem AD or Azure AD/Entra).
   * @property {DeviceEdr[]} presentEdrs Detected EDR agents (empty if none, or if the console asked us to probe none).
   * @property {DeviceDiskEncryption} diskEncryption Disk encryption for the
   *   boot and other mounted fixed volumes.
   */

  /**
   * Collects the device posture from TelemetryEnvironment.currentEnvironment
   * and other data sources.
   *
   * @param {object} [options]
   * @param {string|null} [options.profileDir=null] - Profile whose on-disk addon
   *   database the extension list is read from; without it extensions are
   *   reported as unknown.
   * @returns {Promise<DevicePosture>} devicePosture
   */
  async collect({ profileDir = null } = {}) {
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

    // EdrDetection.getPresentEdrs([]) probes every known agent, so an empty probe
    // list has to short-circuit rather than be passed through.
    const readJsonArrayPref = pref => {
      try {
        // getStringPref's default only covers an unset pref; a pref set to a
        // non-string type still throws, so keep the read inside the try.
        const raw = Services.prefs.getStringPref(pref, "");
        if (!raw) {
          return [];
        }
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch (e) {
        lazy.log.error(`Malformed ${pref}, probing nothing:`, e);
        return [];
      }
    };

    const edrAgentsToProbe = readJsonArrayPref(EDR_AGENTS_PREF);

    const getPresentEDRs = async () => {
      if (!edrAgentsToProbe.length) {
        return [];
      }
      return (await lazy.EdrDetection.getPresentEdrs(edrAgentsToProbe)).map(
        name => ({ name })
      );
    };

    const [
      mobileEquipmentId,
      extensions,
      machineId,
      presentEdrs,
      diskEncryption,
    ] = await Promise.all([
      getImeiValue(),
      this.getExtensions({ profileDir }),
      getMachineId(),
      getPresentEDRs(),
      lazy.DiskEncryption.getStatus(),
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
      diskEncryption,
    };
    return devicePosturePayload;
  },
};

/**
 * Reports device posture to the console for the Felt process: it collects on the
 * policy-poll cadence and submits only what changed, via a posture-carrying token
 * refresh. It also remembers the posture the console holds, which is what the
 * browser-driven refresh reports.
 *
 * State lives on the module rather than on the caller: the Felt process actor is
 * re-created when the content process hosting the login page is recycled, and the
 * record has to outlive that.
 */
export const PostureMonitor = {
  _timer: null,
  _inFlight: null,
  _lastJson: null,
  _lastAt: 0,
  _profileDir: null,
  _intervalMs: DEFAULT_POSTURE_POLL_MS,
  _onRefreshed: null,
  _isSessionOver: null,
  _onRefreshRejected: null,

  /**
   * Starts (or restarts) monitoring. Idempotent, so it is safe to call again
   * across browser restarts and on a new console config.
   *
   * @param {object} options
   * @param {string|null} options.profileDir - Profile whose on-disk add-on list
   *   is reported; see DevicePosture.collect.
   * @param {number} [options.intervalMs]
   * @param {(session: {access_token, refresh_token, expires_at, posture}) => void}
   *   options.onRefreshed - Applies a submission's response; the caller owns the
   *   session.
   * @param {() => boolean} options.isSessionOver - Whether the session was torn
   *   down while a submission was in flight, whose response is then dropped.
   * @param {(error: Error) => void} options.onRefreshRejected - Ends the session
   *   the console refused to refresh; the caller owns the teardown.
   */
  start({
    profileDir,
    intervalMs,
    onRefreshed,
    isSessionOver,
    onRefreshRejected,
  }) {
    this.stop();
    this._profileDir = profileDir;
    this._intervalMs = intervalMs ?? DEFAULT_POSTURE_POLL_MS;
    this._onRefreshed = onRefreshed;
    this._isSessionOver = isSessionOver;
    this._onRefreshRejected = onRefreshRejected;
    this._timer = lazy.setInterval(() => this.tick(), this._intervalMs);
  },

  stop() {
    if (this._timer) {
      lazy.clearInterval(this._timer);
      this._timer = null;
    }
  },

  /**
   * Runs one tick, at most one at a time: a slow collect or refresh keeps the
   * promise in place so the next interval joins it instead of racing it.
   *
   * @returns {Promise<void>}
   */
  tick() {
    if (!this._inFlight) {
      this._inFlight = this._submitIfChanged().finally(() => {
        this._inFlight = null;
      });
    }
    return this._inFlight;
  },

  /**
   * Resolves once no submission is in flight, for a caller tearing the session
   * down.
   *
   * @returns {Promise<void>}
   */
  idle() {
    return Promise.resolve(this._inFlight);
  },

  /**
   * Records the posture the console now holds, and when it was measured: the
   * baseline every later tick diffs against.
   *
   * @param {DevicePosture} posture
   * @param {number} measuredAt - Date.now() when the posture was collected.
   */
  record(posture, measuredAt) {
    this._lastJson = JSON.stringify(posture);
    this._lastAt = measuredAt;
  },

  /**
   * The posture to report on a refresh the browser is blocked on. A collect can
   * spawn subprocesses, so the last measurement is replayed unless it is older
   * than one interval.
   *
   * @returns {Promise<{posture: DevicePosture|null, measuredAt: number|null}>}
   *   measuredAt is null for a posture the console already holds.
   */
  async postureForRefresh() {
    if (this._lastJson && Date.now() - this._lastAt < this._intervalMs) {
      return { posture: JSON.parse(this._lastJson), measuredAt: null };
    }
    try {
      const measuredAt = Date.now();
      const posture = await DevicePosture.collect({
        profileDir: this._profileDir,
      });
      return { posture, measuredAt };
    } catch (e) {
      lazy.log.error("Failed to collect posture for the token refresh:", e);
      return {
        posture: this._lastJson ? JSON.parse(this._lastJson) : null,
        measuredAt: null,
      };
    }
  },

  async _submitIfChanged() {
    try {
      const measuredAt = Date.now();
      const posture = await DevicePosture.collect({
        profileDir: this._profileDir,
      });
      const postureJson = JSON.stringify(posture);
      if (postureJson === this._lastJson) {
        // What the console holds is current as of this measurement, so stamp it
        // and keep the refresh path replaying.
        this._lastAt = measuredAt;
        return;
      }
      lazy.log.debug("Device posture changed; refreshing.");
      const session = await lazy.ConsoleClient.refreshTokens({ posture });
      if (this._isSessionOver()) {
        lazy.log.debug("Session is over; dropping the posture refresh.");
        return;
      }
      this._onRefreshed(session);
      // A call that piggybacked on an in-flight refresh sent an older posture,
      // so leave the record alone and let the next tick retry.
      if (session.postureSubmitted) {
        this.record(posture, measuredAt);
      }
    } catch (e) {
      lazy.log.error("Posture-change refresh failed:", e);
      // The console refusing the refresh token ends the session, as it does on
      // the refresh the browser drives. Posture is reported independently of the
      // browser's credentials, so a network or 5xx failure is left to the next
      // tick instead.
      if (e.name === "ReauthRequiredError" && !this._isSessionOver?.()) {
        this._onRefreshRejected?.(e);
      }
    }
  },
};
