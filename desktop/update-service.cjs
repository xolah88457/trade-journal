"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

/**
 * Sanitizes and redacts sensitive file system paths, credentials, and tokens from error strings.
 * Ensures local environment paths or user directories are never leaked to IPC or renderer.
 */
function redactError(input) {
  if (!input) return null;
  let str = typeof input === "string" ? input : input.message || String(input);

  // Redact URL credentials: https://user:pass@domain -> https://***@domain
  str = str.replace(/(https?:\/\/)([^/\s:@]+):([^/\s:@]+)@/gi, "$1***@");

  // Redact token/key query parameters: ?token=xyz -> ?token=***
  str = str.replace(/([?&](?:token|key|secret|password|sig|signature)=)[^&\s]+/gi, "$1***");

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
 * Resolves the configuration path with strict test-mode hardening.
 * In production, only the bundled desktop/update-config.json is permitted.
 * Under SUMI_TEST_MODE=1, only absolute paths within OS temp directory are accepted.
 */
function resolveConfigPath(customPath) {
  const isTestMode = process.env.SUMI_TEST_MODE === "1";

  if (isTestMode && customPath && typeof customPath === "string") {
    const resolved = path.resolve(customPath);
    const tmp = os.tmpdir();
    const isInTmp =
      resolved.startsWith(tmp) ||
      resolved.startsWith("/tmp") ||
      resolved.startsWith("/private/tmp");

    if (isInTmp && fs.existsSync(resolved)) {
      return resolved;
    }
  }

  return path.join(__dirname, "update-config.json");
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
 * Loads and validates update configuration from disk.
 */
function loadUpdateConfig(resolvedPath) {
  try {
    if (!fs.existsSync(resolvedPath)) {
      return null;
    }
    const raw = fs.readFileSync(resolvedPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Creates the update service coordinating native updaters across macOS (Sparkle),
 * Windows (electron-updater NSIS), and Linux (electron-updater AppImage/deb).
 */
function createUpdateService(options = {}) {
  const platform = options.platform || process.platform;
  if (platform === "darwin") {
    return createSparkleUpdateService(options);
  }
  if (platform === "win32" || platform === "linux") {
    const { createElectronUpdaterService } = require("./update-service-platform.cjs");
    return createElectronUpdaterService(options);
  }
  return {
    getState: () => ({
      status: "unavailable",
      currentVersion:
        options.app && typeof options.app.getVersion === "function"
          ? options.app.getVersion()
          : resolveFallbackVersion(),
      availableVersion: null,
      message: "Updates are not supported on this platform",
      error: null,
      nativeUI: true,
      provider: "unsupported",
    }),
    check: async () => ({
      status: "unavailable",
      currentVersion:
        options.app && typeof options.app.getVersion === "function"
          ? options.app.getVersion()
          : resolveFallbackVersion(),
      availableVersion: null,
      message: "Updates are not supported on this platform",
      error: null,
      nativeUI: true,
      provider: "unsupported",
    }),
    dispose: () => {},
  };
}

/**
 * Creates the Sparkle update service coordinating Electron main process and Sparkle (macOS).

 *
 * Contract (ONLY these three methods — no download/install stubs):
 * - getState() safely serializes only: status, currentVersion, availableVersion, message, error, nativeUI, provider
 * - check() lazily initializes the pinned updater and opens Sparkle native UI (user-driven)
 * - dispose() unregisters listeners and resets the before-relaunch handler
 *
 * Behavior:
 * - No automatic network on app start/mount: initialization is lazy on check() only.
 *   The pinned electron-sparkle 0.2.0 setters setAutomaticallyChecksForUpdates /
 *   setAutomaticallyDownloadsUpdates call requireStarted() and throw
 *   UpdaterNotStartedError before start() resolves, so start() is awaited FIRST,
 *   then both automatics are set to false BEFORE any manual checkForUpdates().
 * - Download and installation are driven exclusively by the native Sparkle UI.
 * - The beforeInstall callback runs ONLY from the native before-relaunch hook
 *   (setBeforeRelaunchHandler), awaited with a bounded timeout — never from check/download.
 * - "update-downloaded" fires BEFORE signature verification completes; state honestly
 *   reports "verifying…" and never claims the download is signature-verified.
 *
 * @param {object} options
 * @param {object} [options.app] Electron app object
 * @param {Function} [options.getWindow] Getter returning BrowserWindow
 * @param {Function} [options.beforeInstall] Async shutdown callback before relaunch
 * @param {Function} [options.updaterFactory] Factory returning Sparkle updater (for DI/testing)
 * @param {string} [options.configPath] Optional custom config path (test mode only)
 */
function createSparkleUpdateService(options = {}) {
  const { app, beforeInstall, updaterFactory, configPath } = options;

  const currentVersion =
    app && typeof app.getVersion === "function" ? app.getVersion() : resolveFallbackVersion();

  let status = "idle";
  let availableVersion = null;
  let message = null;
  let error = null;

  let updaterInstance = null;
  let isInitialized = false;
  let isInitializing = false;
  let isDisposed = false;
  let currentGeneration = 0;
  const unsubscribeFns = [];

  function getState() {
    return {
      status,
      currentVersion,
      availableVersion,
      message,
      error,
      nativeUI: true,
      provider: "sparkle",
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

  async function check() {
    // 1. Platform verification: Sparkle is macOS only
    if (process.platform !== "darwin") {
      status = "unavailable";
      message = "Updates are only supported on macOS";
      error = null;
      return getState();
    }

    // 2. Validate configuration
    const resolvedPath = resolveConfigPath(configPath);
    const config = loadUpdateConfig(resolvedPath);

    if (!config) {
      status = "unavailable";
      error = "Update configuration is missing";
      message = "Updates are unavailable";
      return getState();
    }

    // Enforce Ed25519 public key presence — no insecure fallback
    if (
      !config.publicEdKey ||
      typeof config.publicEdKey !== "string" ||
      config.publicEdKey.trim().length === 0
    ) {
      status = "unavailable";
      error = "Update verification key is not configured";
      message = "Updates are unavailable";
      return getState();
    }

    // Enforce HTTPS feed URL
    if (
      !config.feedUrl ||
      typeof config.feedUrl !== "string" ||
      !config.feedUrl.startsWith("https://")
    ) {
      status = "unavailable";
      error = "Update feed URL must use HTTPS";
      message = "Updates are unavailable";
      return getState();
    }

    // 3. Lazy initialize updater instance
    if (!isInitialized) {
      if (isInitializing) {
        return getState();
      }
      isInitializing = true;
      isDisposed = false;
      const checkGen = ++currentGeneration;

      try {
        if (typeof updaterFactory === "function") {
          updaterInstance = updaterFactory();
        } else {
          try {
            const sparkleModule = require("electron-sparkle");
            updaterInstance = sparkleModule.updater;
          } catch (modErr) {
            status = "unavailable";
            error = redactError(modErr.message || "electron-sparkle module is not installed");
            message = "Update service is unavailable";
            isInitializing = false;
            return getState();
          }
        }

        if (!updaterInstance) {
          status = "unavailable";
          error = "Update service could not be created";
          message = "Updates are unavailable";
          isInitializing = false;
          return getState();
        }

        const localUpdater = updaterInstance;

        // Wire bounded before-relaunch handler (safe BEFORE start in the pinned SDK:
        // setBeforeRelaunchHandler only applies the native hook once started)
        if (typeof localUpdater.setBeforeRelaunchHandler === "function") {
          localUpdater.setBeforeRelaunchHandler(async (update) => {
            if (typeof beforeInstall === "function") {
              let timeoutId = null;
              try {
                await Promise.race([
                  Promise.resolve().then(() => beforeInstall(update)),
                  new Promise((_, reject) => {
                    timeoutId = setTimeout(
                      () => reject(new Error("Pre-relaunch shutdown timed out after 5s")),
                      5000,
                    );
                    if (timeoutId && typeof timeoutId.unref === "function") {
                      timeoutId.unref();
                    }
                  }),
                ]);
              } catch (hookErr) {
                // Redact error, preserve state, and do not forcibly exit or throw uncaught
                error = redactError(hookErr.message || String(hookErr));
              } finally {
                if (timeoutId) {
                  clearTimeout(timeoutId);
                }
              }
            }
          });
        }

        // Attach event listeners via electron-sparkle's on/off API
        // Events: state-changed, update-available, update-not-available, update-downloaded,
        // before-install, before-relaunch, cycle-complete, error
        const addListener = (event, fn) => {
          if (typeof localUpdater.on === "function") {
            localUpdater.on(event, fn);
            unsubscribeFns.push(() => {
              try {
                localUpdater.off(event, fn);
              } catch {}
            });
          }
        };

        addListener("update-available", (event) => {
          status = "available";
          const update = event && event.update;
          availableVersion = (update && (update.displayVersion || update.version)) || null;
          message = availableVersion
            ? `Update ${availableVersion} is available`
            : "An update is available";
          error = null;
        });

        addListener("update-not-available", (event) => {
          status = "not-available";
          message = "Sumi is up to date";
          error = null;
        });

        addListener("update-downloaded", (event) => {
          // update-downloaded fires BEFORE signature verification completes
          // Do NOT say "verified" yet; SUSignatureError (3001) may still occur
          status = "downloaded";
          const update = event && event.update;
          if (update && (update.displayVersion || update.version)) {
            availableVersion = update.displayVersion || update.version;
          }
          message = availableVersion
            ? `Update ${availableVersion} downloaded; verifying…`
            : "Update downloaded; verifying…";
          error = null;
        });

        addListener("before-install", (event) => {
          status = "installing";
          message = "Installing update…";
        });

        addListener("before-relaunch", () => {
          status = "installing";
          message = "Relaunching application…";
        });

        addListener("cycle-complete", () => {
          if (status === "checking") {
            status = "idle";
          }
        });

        addListener("error", (event) => {
          status = "error";
          const err = event && event.error;
          error = redactError(err ? err.message || String(err) : "Update check failed");
          message = "Update check failed";
        });

        // Start the updater FIRST. The pinned electron-sparkle 0.2.0 dist/index.cjs
        // setAutomatically* setters call requireStarted() and throw
        // UpdaterNotStartedError if start() has not resolved yet.
        if (typeof localUpdater.start === "function") {
          await localUpdater.start();
        }

        // Check if disposed while await start was pending
        if (isDisposed || checkGen !== currentGeneration || updaterInstance === null) {
          isInitializing = false;
          return getState();
        }

        // Disable automatic checks/downloads AFTER start, BEFORE the manual check below —
        // strict manual policy: no automatic network on app start/mount; check() is the
        // only trigger and opens the native Sparkle UI.
        if (typeof localUpdater.setAutomaticallyChecksForUpdates === "function") {
          localUpdater.setAutomaticallyChecksForUpdates(false);
        }
        if (typeof localUpdater.setAutomaticallyDownloadsUpdates === "function") {
          localUpdater.setAutomaticallyDownloadsUpdates(false);
        }

        isInitialized = true;
      } catch (initErr) {
        if (isDisposed || checkGen !== currentGeneration || updaterInstance === null) {
          isInitializing = false;
          return getState();
        }
        status = "error";
        error = redactError(initErr.message || String(initErr));
        message = "Failed to initialize update service";
        cleanupListeners();
        updaterInstance = null;
        isInitialized = false;
        isInitializing = false;
        return getState();
      } finally {
        isInitializing = false;
      }
    }

    if (isDisposed || updaterInstance === null) {
      return getState();
    }

    // 4. Initiate check via Sparkle native UI (user-driven, no automatic network on start/mount)
    status = "checking";
    error = null;
    message = "Checking for updates…";

    try {
      if (typeof updaterInstance.checkForUpdates === "function") {
        updaterInstance.checkForUpdates();
      }
    } catch (checkErr) {
      status = "error";
      error = redactError(checkErr.message || String(checkErr));
      message = "Failed to check for updates";
    }

    return getState();
  }

  function dispose() {
    isDisposed = true;
    currentGeneration++;
    cleanupListeners();
    if (updaterInstance && typeof updaterInstance.setBeforeRelaunchHandler === "function") {
      try {
        updaterInstance.setBeforeRelaunchHandler(null);
      } catch {}
    }
    updaterInstance = null;
    isInitialized = false;
    isInitializing = false;
    status = "idle";
  }

  // Native Sparkle UI handles download and installation directly.
  // No programmatic download/install methods exist — the user drives via native UI.
  return {
    getState,
    check,
    dispose,
  };
}

module.exports = {
  createUpdateService,
  redactError,
  resolveConfigPath,
  loadUpdateConfig,
  resolveFallbackVersion,
};
