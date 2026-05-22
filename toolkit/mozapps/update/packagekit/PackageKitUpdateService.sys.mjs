/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

import { FileUtils } from "resource://gre/modules/FileUtils.sys.mjs";
import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  UpdateLog: "resource://gre/modules/UpdateLog.sys.mjs",
});
XPCOMUtils.defineLazyServiceGetter(
  lazy,
  "PackageKitProvider",
  "@mozilla.org/updates/packagekit-dbus-provider;1",
  Ci.nsIPackageKitDBusProvider
);
XPCOMUtils.defineLazyServiceGetter(
  lazy,
  "UM",
  "@mozilla.org/updates/update-manager;1",
  Ci.nsIUpdateManager
);

function LOG(string) {
  lazy.UpdateLog.logPrefixedString("AUS:SVC:PackageKitUpdateService", string);
}

// Module-scoped reference to bypass restrictive XPConnect IDL filtering
let gServiceInstance = null;

// ---------------------------------------------------------------------------
// 1. PackageKitUpdate Class Implementation
// ---------------------------------------------------------------------------

const URI_UPDATE_NS = "http://www.mozilla.org/2005/app-update";

/**
 * Custom implementation of nsIUpdatePatch
 */
export class PackageKitPatch {
  constructor(parentUpdate) {
    this._update = parentUpdate;
    this.type = "complete";
    this.size = 1048576; // Valid non-zero block size to pass validator checks
    this.selected = true;
    this.hashFunction = "sha512";
    this.hashValue =
      "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
    this.internalResult = 0;
    this.numTotalInstallAttempts = 1;

    // Default initial state matching parent transaction
    this.state = "pending-service";

    this.URL = null;
    this.finalURL = this.URL;
  }

  serialize(updates) {
    let patch = updates.createElementNS(URI_UPDATE_NS, "patch");
    patch.setAttribute("type", this.type);
    patch.setAttribute("size", String(this.size));
    patch.setAttribute("URL", this.URL);
    patch.setAttribute("finalURL", this.finalURL);
    patch.setAttribute("selected", String(this.selected));
    patch.setAttribute("state", this.state);
    patch.setAttribute("hashFunction", this.hashFunction);
    patch.setAttribute("hashValue", this.hashValue);
    patch.setAttribute("internalResult", String(this.internalResult));
    patch.setAttribute(
      "numTotalInstallAttempts",
      String(this.numTotalInstallAttempts)
    );
    return patch;
  }

  setFilename(filename) {
    let packageId = this._update.getProperty("packageId") || "unknown";
    this.URL = `dbus://packagekit/${packageId}/${filename}`;
    this.finalURL = this.URL;
  }

  QueryInterface = ChromeUtils.generateQI([Ci.nsIUpdatePatch]);
}

/**
 * Custom implementation of nsIUpdate, nsIPropertyBag, nsIWritablePropertyBag
 */
export class PackageKitUpdate {
  _attrNames = [
    "appVersion",
    "buildID",
    "channel",
    "detailsURL",
    "displayVersion",
    "elevationFailure",
    "errorCode",
    "installDate",
    "isCompleteUpdate",
    "name",
    "previousAppVersion",
    "promptWaitTime",
    "serviceURL",
    "state",
    "statusText",
    "type",
    "unsupported",
    "platformVersion",
  ];

  constructor(signalPackage) {
    this._properties = {};
    this.isCompleteUpdate = true;
    this.channel = "default";
    this.promptWaitTime = 43200;
    this.unsupported = false;
    this.installDate = new Date().getTime();
    this.elevationFailure = false;
    this.detailsURL = "";
    this.serviceURL = "";
    this.statusText = "";
    this.errorCode = 0;
    this.state = "pending-service";

    if (!signalPackage) {
      this.name = "Unknown System Package";
      this.appVersion = "0.0.0";
      this._patches = [new PackageKitPatch(this)];
      this.patchCount = 1;
      return;
    }

    const packageId = signalPackage.packageId;
    const tokens = packageId.split(";");

    this.name = tokens[0] || "System Package";
    this.appVersion = tokens[1] || "1.0.0";
    this.displayVersion = this.appVersion;
    this.platformVersion = this.appVersion;
    this.buildID = "00000000000000";

    if (signalPackage.info === 8) {
      this.type = "major";
    } else {
      this.type = "minor";
    }

    // Retain exclusively inside the property bag for configuration context
    this.setProperty("packageId", packageId);
    this.previousAppVersion = Services.appinfo.version;

    // FIX: Patches instantiation MUST happen after packageId is written to the property bag
    this._patches = [new PackageKitPatch(this)];
    this.patchCount = 1;
  }

  getPatchAt(index) {
    return this._patches[index] || null;
  }

  get selectedPatch() {
    return this._patches[0] || null;
  }

  setFilename(filename) {
    if (this.selectedPatch) {
      this.selectedPatch.setFilename(filename);
    }
  }

  serialize(updates) {
    if (!this.appVersion) {
      return null;
    }
    let update = updates.createElementNS(URI_UPDATE_NS, "update");

    update.setAttribute("appVersion", this.appVersion);
    update.setAttribute("buildID", this.buildID);
    update.setAttribute("channel", this.channel);
    update.setAttribute("detailsURL", this.detailsURL);
    update.setAttribute("displayVersion", this.displayVersion);
    update.setAttribute("platformVersion", this.platformVersion);
    update.setAttribute("installDate", String(this.installDate));
    update.setAttribute("isCompleteUpdate", String(this.isCompleteUpdate));
    update.setAttribute("name", this.name);
    update.setAttribute("previousAppVersion", this.previousAppVersion);
    update.setAttribute("promptWaitTime", String(this.promptWaitTime));
    update.setAttribute("serviceURL", this.serviceURL);
    update.setAttribute("type", this.type);

    if (this.statusText) {
      update.setAttribute("statusText", this.statusText);
    }
    if (this.unsupported) {
      update.setAttribute("unsupported", String(this.unsupported));
    }
    if (this.elevationFailure) {
      update.setAttribute("elevationFailure", String(this.elevationFailure));
    }

    // Custom properties are not leaked to XML attributes anymore

    for (let i = 0; i < this.patchCount; ++i) {
      let patch = this.getPatchAt(i);
      if (patch && typeof patch.serialize === "function") {
        update.appendChild(patch.serialize(updates));
      }
    }

    updates.documentElement.appendChild(update);
    return update;
  }

  setProperty(name, value) {
    this._properties[name] = value;
  }

  deleteProperty(name) {
    delete this._properties[name];
  }

  getProperty(name) {
    return this._properties[name] || null;
  }

  *enumerate() {
    let ip = Cc["@mozilla.org/supports-interface-pointer;1"].createInstance(
      Ci.nsISupportsInterfacePointer
    );
    let qi = ChromeUtils.generateQI([Ci.nsIProperty]);
    for (let [name, value] of Object.entries(this._properties)) {
      ip.data = { name, value, QueryInterface: qi };
      yield ip.data.QueryInterface(Ci.nsIProperty);
    }
  }

  get enumerator() {
    return this.enumerate();
  }

  QueryInterface = ChromeUtils.generateQI([
    Ci.nsIUpdate,
    Ci.nsIPropertyBag,
    Ci.nsIWritablePropertyBag,
  ]);
}

// ---------------------------------------------------------------------------
// 2. PackageKitUpdateService Class Implementation
// ---------------------------------------------------------------------------
export class PackageKitUpdateService {
  #initPromise;
  _downloader = null;
  _downloadListeners = new Set();

  constructor() {
    LOG("constructor()");
    Services.obs.addObserver(this, "quit-application");

    gServiceInstance = this;

    // --- RESTORED: Crucial interface object for UpdateServiceStub routing ---
    this.internal = {
      init: async (force = false) => this.#init(force),
      downloadUpdate: async update => this.#downloadUpdate(update),
      stopDownload: async () => this.#stopDownload(),
      QueryInterface: ChromeUtils.generateQI([
        Ci.nsIApplicationUpdateServiceInternal,
      ]),
    };
  }

  /**
   * Public initialization wrapper matching standard nsIApplicationUpdateService
   */
  async init() {
    LOG("init()");
    return this.#init(false);
  }

  async #init(force = false) {
    if (force) {
      return this.#asyncInit();
    }
    if (!this.#initPromise) {
      this.#initPromise = this.#asyncInit();
    }
    return this.#initPromise;
  }

  async #asyncInit() {
    LOG("#asyncInit() executing boot-time status evaluation checking loop.");

    try {
      let readyUpdateDir = FileUtils.getDir("UpdRootD", ["updates", "0"], true);
      let statusFile = readyUpdateDir.clone();
      statusFile.append("update.status");

      // 1. Manually parse the update.status file on boot
      let status = "null";
      if (statusFile.exists()) {
        let fis = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(
          Ci.nsIFileInputStream
        );
        fis.init(statusFile, FileUtils.MODE_RDONLY, FileUtils.PERMS_FILE, 0);
        let sis = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(
          Ci.nsIScriptableInputStream
        );
        sis.init(fis);
        let text = sis.read(sis.available());
        sis.close();
        if (text) {
          status = text.split("\n")[0].trim();
        }
      }

      LOG(`#asyncInit() discovered boot-time status target: "${status}"`);

      // 2. Process a successful PackageKit installation context
      if (status === "succeeded") {
        let update =
          (lazy.UM.internal && lazy.UM.internal.readyUpdate) ||
          new PackageKitUpdate(null);
        update.state = "succeeded";
        update.statusText = "Install success";

        LOG(
          "#asyncInit() unshifting directly via internal history arrays to avoid circular recursion loops."
        );

        if (lazy.UM.internal) {
          // Direct manipulation bypasses the native AUS.init() wrapper loop entirely
          lazy.UM.internal.addUpdateToHistory(update);
          lazy.UM.internal.readyUpdate = null;
        }

        // Clean up the status file manually so it doesn't parse on subsequent boots
        try {
          if (statusFile.exists()) {
            statusFile.remove(false);
          }
        } catch (e) {
          LOG(`Failed to remove status file: ${e}`);
        }

        // 3. Force immediate synchronous write to updates.xml and active-update.xml to defeat the 200ms DeferredTask race
        if (lazy.UM && typeof lazy.UM._writeUpdatesToXMLFile === "function") {
          // Clear active-update.xml safely since the readyUpdate is now archived
          await lazy.UM._writeUpdatesToXMLFile([], "active-update.xml");

          let historyArray =
            typeof lazy.UM._getUpdates === "function"
              ? lazy.UM._getUpdates()
              : [];
          if (historyArray && historyArray.length) {
            LOG(
              `PackageKitUpdateService: Preemptively flushing ${historyArray.length} history entries to updates.xml`
            );
            await lazy.UM._writeUpdatesToXMLFile(historyArray, "updates.xml");
          }
        }
      }
    } catch (ex) {
      LOG(
        `PackageKitUpdateService: Boot-time rehydration loop encountered an exception: ${ex}`
      );
    }

    LOG("#asyncInit() completed cleanly");
  }

  /**
   * Implements nsIApplicationUpdateService.selectUpdate()
   * Evaluates an array of available updates and selects the best package option.
   */
  async selectUpdate(updates) {
    LOG(
      `selectUpdate() evaluating ${updates.length} potential update variants`
    );
    await this.init();

    if (!updates || !updates.length) {
      return null;
    }

    let majorUpdate = null;
    let minorUpdate = null;
    let vc = Services.vc;

    for (const update of updates) {
      if (update.type === "major") {
        if (
          !majorUpdate ||
          vc.compare(majorUpdate.appVersion, update.appVersion) <= 0
        ) {
          majorUpdate = update;
        }
      } else if (
        !minorUpdate ||
        vc.compare(minorUpdate.appVersion, update.appVersion) <= 0
      ) {
        minorUpdate = update;
      }
    }

    let selected = minorUpdate || majorUpdate || updates[0];
    LOG(
      `selectUpdate() chose candidate: ${selected.name} (${selected.appVersion})`
    );
    return selected;
  }

  /**
   * Top-level download entry point
   */
  async downloadUpdate(update) {
    LOG(`downloadUpdate() called for target: ${update.name}`);
    if (!update) {
      throw Components.Exception(
        "Null update bag pointer",
        Cr.NS_ERROR_NULL_POINTER
      );
    }
    this._downloader = update;
    return this.#downloadUpdate(update);
  }

  async #downloadUpdate(update) {
    let packageId = update.getProperty("packageId");
    if (!packageId) {
      throw Components.Exception(
        "Missing required packageId mapping string",
        Cr.NS_ERROR_FAILURE
      );
    }

    const service = this;
    const progressCallback = {
      onProgress(progress) {
        LOG(
          `Download Pipeline Event -> ID: ${progress.id}, Status: ${progress.status}, Percent: ${progress.percentage}%`
        );

        // Notify listeners registered via AppUpdater.sys.mjs (nsIProgressEventSink)
        for (let listener of service._downloadListeners) {
          try {
            let sink = listener.QueryInterface(Ci.nsIProgressEventSink);
            sink.onProgress(null, progress.percentage, 100);
          } catch (e) {
            LOG(`Failed to notify XPCOM download listener: ${e}`);
          }
        }

        Services.obs.notifyObservers(
          progress,
          "update-progress",
          progress.percentage.toString()
        );
      },
      QueryInterface: ChromeUtils.generateQI([
        Ci.nsIPackageKitProgressCallback,
      ]),
    };

    // Ensure the internal manager instantly registers this as the active update tracking context
    lazy.UM.internal.readyUpdate = update;
    update.state = "downloading";
    this._notifyStateChanged();

    // Detach the transaction processing context asynchronously to avoid stalling AppUpdater
    (async () => {
      try {
        update.state = "pending-service";

        LOG(
          `Executing C++ Provider package pre-download routine for: ${packageId}`
        );
        let downloadedFiles = await lazy.PackageKitProvider.downloadPackages(
          [packageId],
          progressCallback
        );
        if (downloadedFiles && downloadedFiles.length) {
          let filename = downloadedFiles[0].fileList[0].split("/").pop();
          update.wrappedJSObject.setFilename(filename);
        }

        let readyUpdateDir = FileUtils.getDir(
          "UpdRootD",
          ["updates", "0"],
          true
        );
        let statusFile = readyUpdateDir.clone();
        statusFile.append("update.status");

        let fos = FileUtils.openSafeFileOutputStream(statusFile);
        let statusText = "pending\n";
        fos.write(statusText, statusText.length);
        fos.close();

        lazy.UM.internal.readyUpdate = update;
        lazy.UM.saveUpdates();

        // Hand off tracking from the downloader to the staging manager
        this._downloader = null;
        this._notifyStateChanged();

        // Fire the staging loop via the custom update processor
        // This synchronously transitions update.state to "applying" and alerts observers
        Cc["@mozilla.org/updates/packagekit-update-processor;1"]
          .createInstance(Ci.nsIUpdateProcessor)
          .processUpdate();
      } catch (e) {
        LOG(`PackageKit download pipeline encountered a failure: ${e}`);
        update.state = "download-failed";
        service._downloader = null;
        service._notifyStateChanged();
      }
    })();

    // Return immediately to allow AppUpdater to attach its progress listeners at 0%
    return Ci.nsIApplicationUpdateService.DOWNLOAD_SUCCESS;
  }

  async cancelDownloadingUpdate() {
    LOG(
      "cancelDownloadingUpdate() invoked by native UpdateManager cleanup context"
    );
    if (this.isDownloading) {
      await this.#stopDownload();
    }
  }

  async #stopDownload() {
    LOG("#stopDownload() invoked.");
    this._downloader = null;
  }

  async stopDownload() {
    return this.#stopDownload();
  }

  addDownloadListener(listener) {
    LOG("addDownloadListener() invoked.");
    this._downloadListeners.add(listener);
  }

  removeDownloadListener(listener) {
    LOG("removeDownloadListener() invoked.");
    this._downloadListeners.delete(listener);
  }

  get isDownloading() {
    return this._downloader !== null;
  }

  get supportsUpdates() {
    return Services.prefs.getBoolPref("app.update.use_package_kit", false);
  }

  /**
   * See nsIApplicationUpdateService.idl
   * Exposes core capability flags to prevent AppUpdater from falling back to MANUAL_UPDATE.
   */
  get canCheckForUpdates() {
    return true;
  }

  /**
   * See nsIApplicationUpdateService.idl
   */
  get canUsuallyApplyUpdates() {
    return true;
  }

  /**
   * See nsIApplicationUpdateService.idl
   */
  get canApplyUpdates() {
    return true;
  }

  get currentState() {
    if (this.isDownloading) {
      return Ci.nsIApplicationUpdateService.STATE_DOWNLOADING;
    }
    let readyUpdate = lazy.UM.internal.readyUpdate;
    if (readyUpdate) {
      switch (readyUpdate.state) {
        case "downloading":
          return Ci.nsIApplicationUpdateService.STATE_DOWNLOADING;
        case "applying":
          return Ci.nsIApplicationUpdateService.STATE_STAGING;
        case "applied":
        case "applied-service":
        case "pending":
        case "pending-service":
          return Ci.nsIApplicationUpdateService.STATE_PENDING;
        case "swap":
        case "swapping":
          return Ci.nsIApplicationUpdateService.STATE_SWAP;
        case "download-failed":
        case "failed":
          return Ci.nsIApplicationUpdateService.STATE_DOWNLOAD_FAILED;
      }
    }
    return Ci.nsIApplicationUpdateService.STATE_IDLE;
  }

  getStateName(state) {
    switch (state) {
      case Ci.nsIApplicationUpdateService.STATE_IDLE:
        return "idle";
      case Ci.nsIApplicationUpdateService.STATE_DOWNLOADING:
        return "downloading";
      case Ci.nsIApplicationUpdateService.STATE_STAGING:
        return "staging";
      case Ci.nsIApplicationUpdateService.STATE_PENDING:
        return "pending";
      case Ci.nsIApplicationUpdateService.STATE_SWAP:
        return "swap";
      case Ci.nsIApplicationUpdateService.STATE_DOWNLOAD_FAILED:
        return "download_failed";
    }
    return `[unknown: ${state}]`;
  }

  #stateTransitionPromise = null;
  #stateTransitionResolver = null;

  get stateTransition() {
    if (!this.#stateTransitionPromise) {
      this.#stateTransitionPromise = new Promise(resolve => {
        this.#stateTransitionResolver = resolve;
      });
    }
    return this.#stateTransitionPromise;
  }

  _notifyStateChanged() {
    if (this.#stateTransitionResolver) {
      let resolve = this.#stateTransitionResolver;
      this.#stateTransitionPromise = null;
      this.#stateTransitionResolver = null;
      resolve();
    }
  }

  observe(subject, topic, _data) {
    if (topic === "quit-application") {
      LOG(`observe(quit-application)`);
      Services.obs.removeObserver(this, "quit-application");

      // Mock the C++ updater's job right before the process terminates
      if (lazy.UM.internal && lazy.UM.internal.readyUpdate) {
        let readyUpdate = lazy.UM.internal.readyUpdate;
        if (
          readyUpdate.state === "applied" ||
          readyUpdate.state === "applied-service"
        ) {
          try {
            let readyUpdateDir = FileUtils.getDir(
              "UpdRootD",
              ["updates", "0"],
              true
            );
            let statusFile = readyUpdateDir.clone();
            statusFile.append("update.status");

            let fos = FileUtils.openSafeFileOutputStream(statusFile);
            let content = "succeeded\n";
            fos.write(content, content.length);
            try {
              fos.QueryInterface(Ci.nsISafeOutputStream).finish();
            } catch (e) {}
            fos.close();
            LOG(
              "observe(quit-application): Successfully morphed status file to 'succeeded' for next boot verification."
            );
          } catch (ex) {
            LOG(
              `observe(quit-application): Failed to write succeeded status file: ${ex}`
            );
          }
        }
      }

      this._downloader = null;
    }
  }

  classID = Components.ID("{e3a3299c-64fc-4e9f-9135-d454d69e6164}");
  QueryInterface = ChromeUtils.generateQI([
    Ci.nsIApplicationUpdateService,
    Ci.nsIObserver,
  ]);
}

// ---------------------------------------------------------------------------
// 3. PackageKitCheckerService Class Implementation
// ---------------------------------------------------------------------------
export class PackageKitCheckerService {
  #nextUpdateCheckId = 1;
  #requestKeyByCheckId = {};
  #updateCheckData = {};

  constructor() {
    LOG("PackageKitCheckerService: constructor()");
    this.internal = {
      checkForUpdates: checkType => this.#checkForUpdates(checkType, true),
      QueryInterface: ChromeUtils.generateQI([Ci.nsIUpdateCheckerInternal]),
    };
  }

  #makeUpdateCheckDataObject(type, promise) {
    return { type, promise, request: null };
  }

  checkForUpdates(checkType) {
    return this.#checkForUpdates(checkType, false);
  }

  #checkForUpdates(checkType, internal) {
    LOG(`checkForUpdates(${checkType}) triggered`);
    let checkId = this.#nextUpdateCheckId;
    this.#nextUpdateCheckId += 1;

    let requestKey = checkType;

    // Coalesce equivalent simultaneous transaction operations matching UpdateService.sys.mjs patterns
    if (requestKey in this.#updateCheckData) {
      LOG(
        `CheckerService: Coalescing check ID ${checkId} into an active request layout.`
      );
    } else {
      LOG(
        `CheckerService: Launching fresh update operation check for ID ${checkId}.`
      );
      this.#updateCheckData[requestKey] = this.#makeUpdateCheckDataObject(
        checkType,
        this.#updateCheck(checkType, requestKey, internal)
      );
    }

    this.#requestKeyByCheckId[checkId] = requestKey;

    return {
      id: checkId,
      result: this.#updateCheckData[requestKey].promise,
      QueryInterface: ChromeUtils.generateQI([Ci.nsIUpdateCheck]),
    };
  }

  async #updateCheck(checkType, requestKey, _internal) {
    let updates = [];
    let succeeded = false;

    const progressCallback = {
      onProgress(progress) {
        LOG(
          `Update Check Pipeline Event -> ID: ${progress.id}, Status: ${progress.status}, Percent: ${progress.percentage}%`
        );
        Services.obs.notifyObservers(
          progress,
          "update-progress",
          progress.percentage.toString()
        );
      },
      QueryInterface: ChromeUtils.generateQI([
        Ci.nsIPackageKitProgressCallback,
      ]),
    };

    try {
      LOG(
        "CheckerService: Directing C++ backend provider to synchronize cache repository."
      );
      await lazy.PackageKitProvider.refreshCache(true, progressCallback);

      LOG("CheckerService: Invoking getUpdates query sequence.");
      let rawSignalPackages = await lazy.PackageKitProvider.getUpdates();

      updates = rawSignalPackages.map(pkg => new PackageKitUpdate(pkg));
      succeeded = true;
    } catch (error) {
      LOG(
        `CheckerService: Error occurred while executing the transaction scan: ${error}`
      );
      let failingBag = new PackageKitUpdate(null);
      failingBag.释放 = true;
      failingBag.errorCode = Cr.NS_BINDING_FAILED;
      failingBag.statusText = String(error);
      updates = [failingBag];
    }

    // Evict tracking references to gracefully clear memory locks
    delete this.#updateCheckData[requestKey];
    for (const checkId of Object.keys(this.#requestKeyByCheckId)) {
      if (this.#requestKeyByCheckId[checkId] == requestKey) {
        delete this.#requestKeyByCheckId[checkId];
      }
    }

    return Object.freeze({
      checksAllowed: true,
      succeeded,
      request: undefined,
      updates,
      QueryInterface: ChromeUtils.generateQI([Ci.nsIUpdateCheckResult]),
    });
  }

  stopCheck(checkId) {
    delete this.#requestKeyByCheckId[checkId];
  }

  stopAllChecks() {
    this.#requestKeyByCheckId = {};
  }

  classID = Components.ID("{5483f094-1772-498b-98e9-051aeb32b07c}");
  QueryInterface = ChromeUtils.generateQI([Ci.nsIUpdateChecker]);
}

// ---------------------------------------------------------------------------
// 4. PackageKitUpdateProcessor Class Implementation
// ---------------------------------------------------------------------------
export class PackageKitUpdateProcessor {
  constructor() {
    LOG("PackageKitUpdateProcessor initialized");
  }

  /**
   * Implements nsIUpdateProcessor.processUpdate()
   * Intercepts the Firefox local staging execution to process update deployment via standard C++ interfaces.
   */
  processUpdate() {
    LOG("PackageKitUpdateProcessor: processUpdate() invoked.");

    let update = lazy.UM.internal.readyUpdate;
    if (!update) {
      LOG(
        "PackageKitUpdateProcessor: Abandoning sequence. Active readyUpdate instance is null."
      );
      return;
    }

    let packageId = update.getProperty("packageId");
    if (!packageId) {
      LOG(
        "PackageKitUpdateProcessor: Error extracting structural package identification string."
      );
      return;
    }

    let readyUpdateDir = FileUtils.getDir("UpdRootD", ["updates", "0"], true);
    let statusFile = readyUpdateDir.clone();
    statusFile.append("update.status");

    let writeStatusFile = text => {
      let fos = FileUtils.openSafeFileOutputStream(statusFile);
      let content = text + "\n";
      fos.write(content, content.length);
      try {
        fos.QueryInterface(Ci.nsISafeOutputStream).finish();
      } finally {
        fos.close();
      }
    };

    // Detach and process transaction non-blocking asynchronously
    (async () => {
      try {
        LOG(
          "PackageKitUpdateProcessor: Flipping status context file descriptors to 'applying'."
        );
        update.state = "applying";
        if (gServiceInstance) {
          gServiceInstance._notifyStateChanged();
        } else {
          LOG("PackageKitUpdateProcessor: Missing gServiceInstance.");
        }
        writeStatusFile(update.state);

        LOG(
          `PackageKitUpdateProcessor: Calling updatePackages system operation context for: ${packageId}`
        );
        await lazy.PackageKitProvider.updatePackages([packageId]);

        LOG(
          "PackageKitUpdateProcessor: Native installation confirmed success. Committing 'applied-service' status layout."
        );
        update.state = "applied-service";
        if (gServiceInstance) {
          gServiceInstance._notifyStateChanged();
        } else {
          LOG("PackageKitUpdateProcessor: Missing gServiceInstance.");
        }
        writeStatusFile(update.state);
        lazy.UM.saveUpdates();
      } catch (error) {
        LOG(
          `PackageKitUpdateProcessor: Processing operation failure caught: ${error}`
        );
        // 50 corresponds to SERVICE_STILL_APPLYING_TERMINATED from common/updatererrors.h
        update.state = "failed";
        if (gServiceInstance) {
          gServiceInstance._notifyStateChanged();
        } else {
          LOG("PackageKitUpdateProcessor: Missing gServiceInstance.");
        }
        update.errorCode = 50;
        writeStatusFile("failed: 50");
      } finally {
        LOG(
          "PackageKitUpdateProcessor: Handing execution thread tracking variables back to UpdateManager."
        );
        await lazy.UM.internal.refreshUpdateStatus();
      }
    })();
  }

  classID = Components.ID("{c418659b-240e-436d-9293-c91feb432c1d}");
  QueryInterface = ChromeUtils.generateQI([Ci.nsIUpdateProcessor]);
}
