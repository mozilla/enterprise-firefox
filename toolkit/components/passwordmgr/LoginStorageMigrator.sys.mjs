/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  LoginHelper: "resource://gre/modules/LoginHelper.sys.mjs",
});

const PREFS = {
  // Intent: Rust is the desired backend.
  RUST_ENABLED: "signon.storage.rust.enabled",
  // Reality: Rust is the active backend right now. Owned by the migrator.
  // Also drives Sync's engine selection (services/sync/modules/service.sys.mjs).
  RUST_ACTIVE: "signon.storage.rust.active",
  MIGRATION_ATTEMPTS: "signon.storage.rust.migrationAttempts",
};

const MAX_MIGRATION_ATTEMPTS = 10;
const MAX_RUNTIME_RETRIES = 3;

// Replace an origin's scheme with `moz-pwmngr-fixed-<prefix extracted from
// login guid>://`.
// Used during migration when two JSON logins collapse onto the same Rust dedup
// key after origin normalization: rewriting the loser's scheme gives it a
// distinct origin in Rust so both records can be persisted.
function rewriteOriginToFixedScheme(origin, guid) {
  const id = guid.replace(/\W/, "").split("-", 1)[0];
  const idx = origin.indexOf("://");
  if (idx === -1) {
    return `moz-pwmngr-fixed-${id}://${origin}`;
  }
  return `moz-pwmngr-fixed-${id}://${origin.slice(idx + 3)}`;
}

export class LoginStorageMigrator {
  #jsonStorage;
  #rustStorage;
  // Tracks execution progress within a single run() call. Never persisted.
  #retryCount = 0;
  #logger;

  constructor(jsonStorage, rustStorage) {
    this.#jsonStorage = jsonStorage;
    this.#rustStorage = rustStorage;
    this.#logger = lazy.LoginHelper.createLogger("LoginStorageMigrator");
  }

  // Returns the state derived from prefs.
  get #state() {
    const enabled = Services.prefs.getBoolPref(PREFS.RUST_ENABLED, false);
    const active = Services.prefs.getBoolPref(PREFS.RUST_ACTIVE, false);
    if (!enabled) {
      return active ? "RevertPending" : "JSONPrimary";
    }
    return active ? "RustPrimary" : "MigrationPending";
  }

  // Runs the migration if necessary and returns the active storage backend.
  async run() {
    switch (this.#state) {
      case "RustPrimary":
        return this.#rustStorage;

      case "MigrationPending":
        if (
          Services.prefs.getIntPref(PREFS.MIGRATION_ATTEMPTS, 0) >=
          MAX_MIGRATION_ATTEMPTS
        ) {
          return this.#exceedMigrationBudget();
        }
        return this.#startMigration();

      case "RevertPending":
        return this.#deactivateRust();

      default:
        return this.#jsonStorage;
    }
  }

  // Atm only supported either unlocked or without Primary Password.
  async #startMigration() {
    if (
      lazy.LoginHelper.isPrimaryPasswordSet() &&
      !this.#jsonStorage.isLoggedIn
    ) {
      return this.#jsonStorage;
    }
    return this.#executeMigration();
  }

  async #executeMigration() {
    this.#logger.log("Starting migration...");

    const t0 = Date.now();
    const attempt = Services.prefs.getIntPref(PREFS.MIGRATION_ATTEMPTS, 0);
    const primaryPasswordSet = lazy.LoginHelper.isPrimaryPasswordSet();
    let numberOfLoginsToMigrate = 0;
    let numberOfLoginsMigrated = 0;
    let numberOfLoginsQuarantined = 0;
    let numberOfVulnerablePasswords = 0;
    let fatalError = null;

    try {
      await this.#rustStorage.removeAllLoginsAsync();
      await this.#rustStorage.clearAllPotentiallyVulnerablePasswords();

      const logins = await this.#jsonStorage.getAllLogins(false);
      numberOfLoginsToMigrate = logins.length;

      // Sort by timePasswordChanged descending so the most recently changed
      // password wins origin-normalization collisions; older duplicates are
      // quarantined under moz-pwmngr-fixed:// below.
      const sortedLogins = [...logins].sort(
        (a, b) => (b.timePasswordChanged || 0) - (a.timePasswordChanged || 0)
      );

      const results =
        await this.#rustStorage.addLoginsWithResultsAsync(sortedLogins);
      const failedLogins = results
        .map(({ error }, i) => ({
          login: sortedLogins[i],
          error,
          isDuplicate: /Login already exists/i.test(error?.message || ""),
        }))
        .filter(({ error }) => error);

      numberOfLoginsMigrated += results.length - failedLogins.length;

      const duplicates = [];
      for (const { isDuplicate, error, login } of failedLogins) {
        if (isDuplicate) {
          const rescued = login.clone();
          rescued.QueryInterface(Ci.nsILoginMetaInfo);
          rescued.origin = rewriteOriginToFixedScheme(login.origin, login.guid);
          duplicates.push(rescued);
        } else {
          this.#logger.error("Migration error:", error.message);
        }
      }

      const duplicatesResults =
        await this.#rustStorage.addLoginsWithResultsAsync(duplicates);
      for (const { error } of duplicatesResults) {
        if (error) {
          this.#logger.error(
            "Migration error for rescued duplicate:",
            error.message
          );
        } else {
          numberOfLoginsMigrated++;
          numberOfLoginsQuarantined++;
        }
      }

      const potentiallyVulnerablePasswords =
        this.#jsonStorage.decryptedPotentiallyVulnerablePasswords;
      numberOfVulnerablePasswords = potentiallyVulnerablePasswords.length;
      try {
        await this.#rustStorage.addPotentiallyVulnerablePasswords(
          potentiallyVulnerablePasswords
        );
      } catch (e) {
        this.#logger.error("Vulnerable passwords migration error:", e);
      }

      return this.#completeMigration();
    } catch (e) {
      this.#logger.error("Migration failed:", e);
      fatalError = e;
      return this.#failMigration(e);
    } finally {
      this.#logger.log(
        `Migration ${fatalError ? "failed" : "completed"} in ` +
          `${Date.now() - t0}ms: ${numberOfLoginsMigrated}/` +
          `${numberOfLoginsToMigrate} migrated, ${numberOfLoginsQuarantined} ` +
          `quarantined, ${numberOfVulnerablePasswords} vulnerable, ` +
          `attempt ${attempt}, primaryPasswordSet=${primaryPasswordSet}`
      );
    }
  }

  #completeMigration() {
    Services.prefs.setBoolPref(PREFS.RUST_ACTIVE, true);
    Services.prefs.setIntPref(PREFS.MIGRATION_ATTEMPTS, 0);
    return this.#rustStorage;
  }

  async #failMigration(_error) {
    if (this.#retryCount < MAX_RUNTIME_RETRIES) {
      return this.#retryMigration();
    }
    return this.#abortMigration();
  }

  async #retryMigration() {
    this.#retryCount++;
    return this.#executeMigration();
  }

  #abortMigration() {
    Services.prefs.setIntPref(
      PREFS.MIGRATION_ATTEMPTS,
      Services.prefs.getIntPref(PREFS.MIGRATION_ATTEMPTS, 0) + 1
    );
    // rust.enabled is not reset — next startup retries automatically.
    return this.#jsonStorage;
  }

  #exceedMigrationBudget() {
    Services.prefs.setBoolPref(PREFS.RUST_ENABLED, false);
    Services.prefs.setIntPref(PREFS.MIGRATION_ATTEMPTS, 0);
    return this.#jsonStorage;
  }

  // Rust is no longer the desired backend but is still active. Deactivate it;
  // changes made while Rust was active are lost. Reset the attempt budget so a
  // later re-enable starts fresh.
  #deactivateRust() {
    Services.prefs.setBoolPref(PREFS.RUST_ACTIVE, false);
    Services.prefs.setIntPref(PREFS.MIGRATION_ATTEMPTS, 0);
    return this.#jsonStorage;
  }
}
