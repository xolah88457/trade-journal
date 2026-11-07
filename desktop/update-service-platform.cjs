"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

/**
 * Sanitizes and redacts sensitive file system paths, credentials, and tokens from error strings.
 */
function redactError(input) {
  if (!input) return null;
  let str = typeof input === "string" ? input : input.message || String(input);

  // Redact URL credentials: https://user:pass@domain -> https://***@domain
  str = str.replace(/(https?:\/\/)([^/\s:@]+):([^/\s:@]+)@/gi, "$1***@");

  // Redact token/key query parameters: ?token=xyz or /token=xyz -> ?token=***
  str = str.replace(/([/?&](?:token|key|secret|password|sig|signature)=)[^&\s]+/gi, "$1***");

  // Redact absolute Unix file paths
  str = str.replace(
    /(?:\/(?:Users|home|private|tmp|var|System|Applications|Volumes|opt|usr)\b[^\s:"'<>)]*)/gi,
    "[path]",
  );

  // Redact Windows absolute file paths
  str = str.replace(/[A-Za-z]:\\[^\s:"'<>)]*/gi, "[path]");

  return str.trim();
}

/**
 * Resolves the fallback version from the root package.json if app.getVersion() is unavailable.
 */
function resolveFallbackVersion() {
  try {
    const pkg = require("../package.json");
    if (pkg && typeof pkg.version === "string" && pkg.version.trim()) {
      return pkg.version.trim();
    }
  } catch {}
  return "0.3.0";
}

/**
 * Resolves the genuine builder-util-runtime CancellationToken class from electron-updater's
 * dependency context using createRequire. Never invents fake token objects.
 */
function resolveCancellationTokenClass(options = {}) {
  if (options && typeof options.cancellationTokenClass === "function") {
    return options.cancellationTokenClass;
  }
  try {
    const updaterPath = require.resolve("electron-updater");
    const updaterRequire = createRequire(updaterPath);
    const runtime = updaterRequire("builder-util-runtime");
    if (runtime && typeof runtime.CancellationToken === "function") {
      return runtime.CancellationToken;
    }
  } catch {}
  return null;
}

/**
 * Detects the Linux packaging format:
 * - "appimage": process.env.APPIMAGE is set
 * - "deb", "rpm", "pacman": Resources/package-type identity file exists
 * - "portable": tarball / unpacked / portable run (cannot self-update)
 */
function detectLinuxPackageType(options = {}) {
  const env = options.env || process.env;
  if (env && env.APPIMAGE) {
    return "appimage";
  }

  const resourcesPath =
    options.resourcesPath !== undefined
      ? options.resourcesPath
      : (process && process.resourcesPath) || "";

  if (resourcesPath) {
    const pkgTypeFile = path.join(resourcesPath, "package-type");
    try {
      if (fs.existsSync(pkgTypeFile)) {
        const fileType = fs.readFileSync(pkgTypeFile, "utf8").trim().toLowerCase();
        if (fileType === "deb" || fileType === "rpm" || fileType === "pacman") {
          return fileType;
        }
      }
    } catch {}
  }

  return "portable";
}

/**
 * Checks whether the current platform and package format supports automatic updates.
 */
function isPlatformUpdatable(options = {}) {
  const platform = options.platform || process.platform;

  if (platform === "darwin") {
    return { updatable: true, provider: "sparkle" };
  }

  if (platform === "win32") {
    return { updatable: true, provider: "electron-updater", packageType: "nsis" };
  }

  if (platform === "linux") {
    const pkgType = detectLinuxPackageType(options);
    if (pkgType === "deb" || pkgType === "rpm" || pkgType === "pacman" || pkgType === "appimage") {
      return { updatable: true, provider: "electron-updater", packageType: pkgType };
    }
    return {
      updatable: false,
      provider: "electron-updater",
      packageType: "portable",
      reason: "portable_linux",
      message:
        "Automatic updates are not supported for portable or tarball installations. Please update manually or install via AppImage or .deb.",
    };
  }

  return {
    updatable: false,
    provider: "unsupported",
    reason: "unsupported_platform",
    message: "Updates are not supported on this platform",
  };
}

/**
 * Creates the Windows & Linux update service adapter coordinating Electron dialogs and electron-updater.
 *
 * Contract:
 * - getState() safely serializes 7 fields: status, currentVersion, availableVersion, message, error, nativeUI: true, provider: "electron-updater"
 * - check() checks for updates, displays native dialogs for consent, downloads with checksum verification,
 *   and prompts for install+restart with safe backend shutdown before quitAndInstall.
 * - dispose() cancels active downloads, unregisters listeners, and resets state.
 *
 * Strict Policies:
 * - No startup/mount network: check() is the ONLY trigger.
 * - Single-flight guard preserved across all async awaits and native dialogs.
 * - Generation / disposal check after every await prevents stale dialogs or install triggers after disposal.
 * - Canonical GitHub repo: xolah88457/trade-journal stable releases.
 * - autoDownload = false, autoInstallOnAppQuit = false, allowDowngrade = false.
 * - Real CancellationToken from builder-util-runtime (never fake token fallback).
 * - Incomplete SDK methods or null checkResult never produce false-green "up to date".
 * - Bounded beforeInstall hook (5s timeout) flushes SQLite before relaunch.
 */
function createElectronUpdaterService(options = {}) {
  const {
    app,
    getWindow,
    beforeInstall,
    updaterFactory,
    dialog: dialogOverride,
    platform = process.platform,
    resourcesPath = (process && process.resourcesPath) || "",
    gitHubOwner = "xolah88457",
    gitHubRepo = "trade-journal",
  } = options;

  const currentVersion =
    app && typeof app.getVersion === "function" ? app.getVersion() : resolveFallbackVersion();
  const CancellationTokenClass = resolveCancellationTokenClass(options);

  let status = "idle";
  let availableVersion = null;
  let message = null;
  let error = null;

  let updaterInstance = null;
  let isInitialized = false;
  let inFlight = false;
  let isDisposed = false;
  let currentGeneration = 0;
  let activeCancellationToken = null;
  const unsubscribeFns = [];

  function getState() {
    return {
      status,
      currentVersion,
      availableVersion,
      message,
      error,
      nativeUI: true,
      provider: "electron-updater",
    };
  }

  function cleanupListeners() {
    for (const fn of unsubscribeFns) {
      try {
        fn();
      } catch {}
    }
    unsubscribeFns.length = 0;
  }

  function getDialog() {
    if (dialogOverride) return dialogOverride;
    try {
      const electron = require("electron");
      return electron.dialog || null;
    } catch {
      return null;
    }
  }

  function initUpdater() {
    if (isInitialized) return true;

    if (typeof updaterFactory === "function") {
      updaterInstance = updaterFactory();
    } else {
      try {
        const electronUpdater = require("electron-updater");
        updaterInstance = electronUpdater.autoUpdater;
      } catch (modErr) {
        status = "unavailable";
        error = redactError(modErr.message || "electron-updater module is not installed");
        message = "Update service is unavailable";
        return false;
      }
    }

    if (!updaterInstance) {
      status = "unavailable";
      error = "Update service could not be created";
      message = "Updates are unavailable";
      return false;
    }

    // Validate real required SDK methods on updaterInstance
    if (
      typeof updaterInstance.checkForUpdates !== "function" ||
      typeof updaterInstance.downloadUpdate !== "function" ||
      typeof updaterInstance.quitAndInstall !== "function"
    ) {
      status = "unavailable";
      error = "Update service is missing required updater methods";
      message = "Update service is unavailable";
      return false;
    }

    // Canonical fixed GitHub provider: xolah88457/trade-journal
    if (typeof updaterInstance.setFeedURL === "function") {
      try {
        updaterInstance.setFeedURL({
          provider: "github",
          owner: gitHubOwner,
          repo: gitHubRepo,
        });
      } catch {}
    }

    // Strict manual update policies
    updaterInstance.autoDownload = false;
    updaterInstance.autoInstallOnAppQuit = false;
    updaterInstance.allowDowngrade = false;
    updaterInstance.allowPrerelease = false;

    // Attach event listeners
    const addListener = (event, fn) => {
      if (typeof updaterInstance.on === "function") {
        updaterInstance.on(event, fn);
        unsubscribeFns.push(() => {
          try {
            if (typeof updaterInstance.off === "function") {
              updaterInstance.off(event, fn);
            } else if (typeof updaterInstance.removeListener === "function") {
              updaterInstance.removeListener(event, fn);
            }
          } catch {}
        });
      }
    };

    addListener("update-available", (info) => {
      status = "available";
      availableVersion = info && info.version ? info.version : null;
      message = availableVersion
        ? `Update ${availableVersion} is available`
        : "An update is available";
      error = null;
    });

    addListener("update-not-available", () => {
      status = "not-available";
      message = "Sumi is up to date";
      error = null;
    });

    addListener("download-progress", (progress) => {
      status = "downloading";
      const pct =
        progress && typeof progress.percent === "number" && !Number.isNaN(progress.percent)
          ? Math.round(progress.percent)
          : null;
      message = pct !== null ? `Downloading update… (${pct}%)` : "Downloading update…";
    });

    addListener("update-downloaded", (info) => {
      status = "downloaded";
      if (info && info.version) {
        availableVersion = info.version;
      }
      message = availableVersion
        ? `Update ${availableVersion} downloaded; ready to install.`
        : "Update downloaded; ready to install.";
      error = null;
    });

    addListener("error", (err) => {
      status = "error";
      error = redactError(err ? err.message || String(err) : "Update check failed");
      message = "Update check failed";
    });

    isInitialized = true;
    return true;
  }

  async function check() {
    // 1. Single-flight guard: prevent duplicate concurrent checks
    if (inFlight) {
      return getState();
    }

    // 2. Linux packaging check: tarball / portable non-updatable states honest (no false green)
    if (platform === "linux") {
      const updatableInfo = isPlatformUpdatable({
        platform,
        resourcesPath,
        env: options.env,
      });
      if (!updatableInfo.updatable && !options.forceDevUpdateConfig) {
        status = "unavailable";
        message = updatableInfo.message;
        error = null;
        return getState();
      }
    }

    // 3. Lazy initialize updater instance and validate required SDK methods
    if (!initUpdater()) {
      return getState();
    }

    inFlight = true;
    isDisposed = false;
    const checkGen = ++currentGeneration;

    status = "checking";
    error = null;
    message = "Checking for updates…";

    const dialog = getDialog();

    function resolveParentWindow() {
      if (typeof getWindow !== "function") return undefined;
      try {
        const win = getWindow();
        if (!win) return undefined;
        if (typeof win.isDestroyed === "function" && win.isDestroyed()) {
          return undefined;
        }
        return win;
      } catch {
        return undefined;
      }
    }

    try {
      let checkResult = null;
      try {
        checkResult = await updaterInstance.checkForUpdates();
      } catch (checkErr) {
        if (isDisposed || checkGen !== currentGeneration) return getState();
        status = "error";
        error = redactError(checkErr.message || String(checkErr));
        message = "Update check failed";
        return getState();
      }

      // Generation check after await checkForUpdates
      if (isDisposed || checkGen !== currentGeneration) {
        return getState();
      }

      // Preserve error state if an error event fired during check
      if (status === "error") {
        return getState();
      }

      // Null checkResult (e.g. inactive updater in dev mode): NEVER claim false-green "up to date"
      if (checkResult == null) {
        status = "unavailable";
        message =
          "Update check returned no result. Updates may be inactive in unpacked development.";
        error = null;
        return getState();
      }

      // Determine availability:
      const updateInfo = checkResult.updateInfo || checkResult.versionInfo || null;
      if (updateInfo && updateInfo.version) {
        availableVersion = updateInfo.version;
      }

      const isAvailable =
        checkResult.isUpdateAvailable === true ||
        (status === "available" && availableVersion !== null);

      if (!isAvailable || status === "not-available") {
        status = "not-available";
        message = "Sumi is up to date";
        error = null;

        // Native dialog: "Sumi is up to date"
        if (dialog && typeof dialog.showMessageBox === "function") {
          try {
            const win = resolveParentWindow();
            await dialog.showMessageBox(win, {
              type: "info",
              title: "Update Check",
              message: "Sumi is up to date",
              detail: `You are running the latest version (${currentVersion}).`,
              buttons: ["OK"],
            });
          } catch {}
        }

        return getState();
      }

      // Update is available! Single-flight guard remains ACTIVE while user evaluates dialog
      status = "available";
      message = availableVersion
        ? `Update ${availableVersion} is available`
        : "An update is available";
      error = null;

      // Ask user for Download consent via native Electron dialog
      let downloadConsent = false;
      if (dialog && typeof dialog.showMessageBox === "function") {
        try {
          const win = resolveParentWindow();
          const choice = await dialog.showMessageBox(win, {
            type: "info",
            title: "Update Available",
            message: `A new version of Sumi is available (${availableVersion || "latest"}).`,
            detail: `You are currently running version ${currentVersion}. Would you like to download this update?`,
            buttons: ["Download", "Later"],
            defaultId: 0,
            cancelId: 1,
          });
          downloadConsent = choice && choice.response === 0;
        } catch {
          downloadConsent = false;
        }
      }

      // Generation check after download dialog await: disposal must not proceed
      if (isDisposed || checkGen !== currentGeneration) {
        return getState();
      }

      if (!downloadConsent) {
        // User cancelled before download
        message = availableVersion
          ? `Update ${availableVersion} is available (download postponed)`
          : "Update available (download postponed)";
        return getState();
      }

      // User consented to download!
      status = "downloading";
      message = availableVersion
        ? `Downloading update ${availableVersion}…`
        : "Downloading update…";

      try {
        if (CancellationTokenClass) {
          activeCancellationToken = new CancellationTokenClass();
        }
        await updaterInstance.downloadUpdate(activeCancellationToken || undefined);
      } catch (dlErr) {
        if (isDisposed || checkGen !== currentGeneration) return getState();
        status = "error";
        error = redactError(dlErr.message || String(dlErr));
        message = "Download failed";
        return getState();
      } finally {
        activeCancellationToken = null;
      }

      // Generation check after download await: disposal must not proceed
      if (isDisposed || checkGen !== currentGeneration) {
        return getState();
      }

      // If error event was dispatched during download (e.g. checksum failure), preserve it
      if (status === "error") {
        return getState();
      }

      status = "downloaded";
      message = availableVersion
        ? `Update ${availableVersion} downloaded; ready to install.`
        : "Update downloaded; ready to install.";

      // Ask user for Install+Restart consent with save-work warning
      let installConsent = false;
      if (dialog && typeof dialog.showMessageBox === "function") {
        try {
          const win = resolveParentWindow();
          const choice = await dialog.showMessageBox(win, {
            type: "question",
            title: "Update Ready to Install",
            message: `Update ${availableVersion || ""} has been downloaded.`,
            detail:
              "Sumi will close and restart to install the update. Please ensure all your work is saved before continuing.",
            buttons: ["Install and Restart", "Later"],
            defaultId: 0,
            cancelId: 1,
          });
          installConsent = choice && choice.response === 0;
        } catch {
          installConsent = false;
        }
      }

      // Generation check after install dialog await: disposal must not proceed
      if (isDisposed || checkGen !== currentGeneration) {
        return getState();
      }

      if (!installConsent) {
        // User postponed installation
        message = availableVersion
          ? `Update ${availableVersion} downloaded (restart postponed)`
          : "Update downloaded (restart postponed)";
        return getState();
      }

      // User consented to Install and Restart!
      status = "installing";
      message = "Installing update…";

      // Safe backend shutdown callback before relaunch
      if (typeof beforeInstall === "function") {
        let timeoutId = null;
        try {
          await Promise.race([
            Promise.resolve().then(() => beforeInstall()),
            new Promise((_, reject) => {
              timeoutId = setTimeout(
                () => reject(new Error("Pre-install shutdown timed out after 5s")),
                5000,
              );
              if (timeoutId && typeof timeoutId.unref === "function") {
                timeoutId.unref();
              }
            }),
          ]);
        } catch (shutErr) {
          error = redactError(shutErr.message || String(shutErr));
        } finally {
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
        }
      }

      // Generation check after beforeInstall shutdown
      if (isDisposed || checkGen !== currentGeneration) {
        return getState();
      }

      // Call SDK quitAndInstall
      if (typeof updaterInstance.quitAndInstall === "function") {
        updaterInstance.quitAndInstall(false, true);
      }

      return getState();
    } catch (unexpectedErr) {
      status = "error";
      error = redactError(unexpectedErr.message || String(unexpectedErr));
      message = "Update check failed";
      return getState();
    } finally {
      if (checkGen === currentGeneration) {
        inFlight = false;
      }
    }
  }

  function dispose() {
    isDisposed = true;
    currentGeneration++;
    if (activeCancellationToken && typeof activeCancellationToken.cancel === "function") {
      try {
        activeCancellationToken.cancel();
      } catch {}
    }
    activeCancellationToken = null;
    cleanupListeners();
    updaterInstance = null;
    isInitialized = false;
    inFlight = false;
    status = "idle";
  }

  return {
    getState,
    check,
    dispose,
  };
}

module.exports = {
  redactError,
  resolveCancellationTokenClass,
  detectLinuxPackageType,
  isPlatformUpdatable,
  createElectronUpdaterService,
  resolveFallbackVersion,
};
