/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ConsoleClient: "resource://gre/modules/enterprise/ConsoleClient.sys.mjs",
  CrashServiceUtils: "resource://gre/modules/CrashService.sys.mjs",
  createEnterpriseLogger:
    "resource://gre/modules/enterprise/EnterpriseCommon.sys.mjs",
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  return lazy.createEnterpriseLogger("FeltCrashReporter");
});

/* Modification time of the last minidump we launched the client for. Dumps are
 * only ever reported newest-first, so one high-water mark is enough to keep us
 * from reporting the same crash twice; there is no need to remember individual
 * paths. The client normally moves a dump out of the profile once it is done
 * with it, but that happens asynchronously and can fail, so we cannot rely on
 * the dump having disappeared. */
let gLastReportedMtime = 0;

/* Slack applied to the "newer than the browser launch" test. Some filesystems
 * only store whole-second modification times, so a dump written moments after
 * the launch can look fractionally older than it. Being slightly generous risks
 * re-examining a dump from the previous run, which the high-water mark above
 * then filters out; being strict would silently drop real crashes. */
const MTIME_SLACK_MS = 2000;

/**
 * Launches the crash reporter client for a browser process that exited
 * abnormally.
 *
 * In a Felt-launched browser the crashing process writes the minidump and the
 * matching `.extra` file but does not start the client itself (see
 * `gFeltLaunchesCrashReporter` in nsExceptionHandler.cpp). Starting it from
 * here instead means the upload can be authenticated with a console access
 * token that is fresh at upload time: Felt owns the refresh token, so it can
 * renew an expired token, which the crashing process could never do.
 */
export const FeltCrashReporter = {
  /**
   * Launch the crash reporter client for the most recent crash of the browser
   * that was running against `profilePath`.
   *
   * @param {string} profilePath - Root directory of the crashed browser's profile
   * @param {number} notBefore - Only consider minidumps modified at or after
   *                 this time (ms since epoch), so we never re-report a crash
   *                 from an earlier run
   * @returns {Promise<boolean>} whether the client was launched
   */
  async report(profilePath, notBefore) {
    if (!profilePath) {
      lazy.log.debug("report: no profile path for the crashed browser");
      return false;
    }

    if (Services.env.get("MOZ_CRASHREPORTER_NO_REPORT")) {
      // The browser inherits our environment, so this is the same value that
      // would have stopped it from launching the client itself.
      lazy.log.debug("report: crash reporting disabled in the environment");
      return false;
    }

    const dump = await this._findMinidump(profilePath, notBefore);
    if (!dump) {
      // Not every abnormal exit leaves a minidump behind: the process may have
      // been killed outright (SIGKILL, OOM killer) or the crash may have been
      // taken over by Windows Error Reporting.
      lazy.log.debug("report: no new minidump found, nothing to report");
      return false;
    }
    const { path: dumpPath, lastModified } = dump;

    if (await this._isDisabledByPolicy(dumpPath)) {
      lazy.log.debug("report: crash reporting disabled by policy");
      return false;
    }

    const environment = {
      // The client needs this to correlate the crash ping with the event the
      // crashing process already wrote; it has no fallback for it.
      MOZ_CRASHREPORTER_EVENTS_DIRECTORY: PathUtils.join(
        profilePath,
        "crashes",
        "events"
      ),
    };

    const token = await this._accessToken();
    if (token) {
      environment.MOZ_CRASHREPORTER_AUTH_TOKEN = token;
    } else {
      // Still worth reporting: the console may accept the upload unauthenticated,
      // and the report otherwise stays in the pending directory for a later
      // authenticated retry from the browser.
      lazy.log.warn("report: no access token, uploading unauthenticated");
    }

    const command = lazy.CrashServiceUtils.getCrashReporterPath().path;
    lazy.log.debug(`report: launching ${command} for ${dumpPath}`);
    gLastReportedMtime = lastModified;

    try {
      await this._launch(command, [dumpPath], environment);
    } catch (e) {
      lazy.log.error(`report: failed to launch the crash reporter: ${e}`);
      return false;
    }

    return true;
  },

  /**
   * Spawn the crash reporter client. Split out from report() so that tests can
   * exercise the surrounding logic without starting a real process.
   *
   * @param {string} command - Path to the client executable
   * @param {string[]} args - Arguments to pass to it
   * @param {object} environment - Environment entries to add to our own
   */
  async _launch(command, args, environment) {
    const proc = await lazy.Subprocess.call({
      command,
      arguments: args,
      environment,
      environmentAppend: true,
      stdout: "stdout",
      stderr: "stderr",
    });
    proc.exitPromise.then(() =>
      lazy.log.debug(`crash reporter exited with ${proc.exitCode}`)
    );
  },

  /**
   * Find the newest minidump written by the crashed browser.
   *
   * A dump is only considered once its `.extra` file exists, since the client
   * cannot do anything useful without it and the crashing process writes the
   * two separately. Dumps at or below the high-water mark are skipped, so a
   * dump we have already reported is never picked up again even if the client
   * has not moved it out of the profile yet.
   *
   * @param {string} profilePath - Root directory of the crashed browser's profile
   * @param {number} notBefore - Oldest acceptable modification time, in ms since epoch
   * @returns {Promise<?{path: string, lastModified: number}>} the minidump, or
   *          null if there is none
   */
  async _findMinidump(profilePath, notBefore) {
    const minidumpsDir = PathUtils.join(profilePath, "minidumps");
    const children = await IOUtils.getChildren(minidumpsDir, {
      ignoreAbsent: true,
    });

    let newestPath = null;
    let newestTime = gLastReportedMtime;

    for (const path of children) {
      if (!path.endsWith(".dmp")) {
        continue;
      }
      const extraPath = `${path.slice(0, -".dmp".length)}.extra`;
      if (!(await IOUtils.exists(extraPath))) {
        continue;
      }
      const { lastModified } = await IOUtils.stat(path);
      if (
        lastModified < notBefore - MTIME_SLACK_MS ||
        lastModified <= newestTime
      ) {
        continue;
      }
      newestPath = path;
      newestTime = lastModified;
    }

    return newestPath && { path: newestPath, lastModified: newestTime };
  },

  /**
   * Whether the CrashReportsSubmit policy that was in force when the browser
   * crashed disables crash reporting altogether.
   *
   * The policy normally reaches the client through MOZ_CRASHREPORTER_NO_REPORT
   * in the crashing process' environment, which we do not inherit, so the
   * browser also records it as an annotation.
   *
   * @param {string} dumpPath - Path to the minidump
   * @returns {Promise<boolean>} true only if the policy explicitly disables reporting
   */
  async _isDisabledByPolicy(dumpPath) {
    const extraPath = `${dumpPath.slice(0, -".dmp".length)}.extra`;
    try {
      const extra = await IOUtils.readJSON(extraPath);
      return extra.EnterpriseCrashReportsSubmit === "0";
    } catch (e) {
      // A missing or malformed .extra is the client's problem to report, not a
      // reason for us to withhold the crash.
      lazy.log.warn(`Could not read ${extraPath}: ${e}`);
      return false;
    }
  },

  /**
   * Get an access token valid for the crash report upload, refreshing it if the
   * one we hold has expired.
   *
   * @returns {Promise<string>} the token, or an empty string if none could be obtained
   */
  async _accessToken() {
    const token = Services.felt.getAccessTokenIfValid();
    if (token) {
      return token;
    }

    try {
      const { access_token, refresh_token, expires_at } =
        await lazy.ConsoleClient.refreshTokens();
      Services.felt.setTokens(access_token, refresh_token, expires_at);
      return access_token;
    } catch (e) {
      lazy.log.error(`Failed to refresh the token for the crash report: ${e}`);
      return "";
    }
  },
};
