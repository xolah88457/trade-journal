"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn, execFileSync } = require("node:child_process");

// Conditionally require electron to allow unit tests and node --check to run cleanly
let electron;
try {
  electron = require("electron");
} catch {
  electron = null;
}

const { app, BrowserWindow, ipcMain, Menu, shell, dialog, session } = electron || {};

const { resolveDataDirectory, createPreferencesStore } = require("./preferences.cjs");
const {
  validateOrigin,
  isTrustedSender,
  isSafeExternalUrl,
  setupSecurityHandlers,
} = require("./security.cjs");

/**
 * Child runtime environment whitelist.
 * Explicitly whitelists PATH, HOME, TMPDIR, LANG, and JOURNAL_DATA_DIR.
 * Prepends trusted runtimeDirectory to PATH so bundled runtime DLLs/CRTs resolve reliably on Windows.
 * On Windows, preserves essential system variables (SystemRoot, TEMP, USERPROFILE, etc.).
 * Strictly avoids inheriting NODE_OPTIONS, API keys, or arbitrary shell variables.
 */
function buildChildEnv(dataDir, options = {}) {
  const platform = options.platform || process.platform;
  const delimiter = platform === "win32" ? ";" : ":";

  const defaultPath =
    platform === "win32" ? "C:\\Windows\\System32;C:\\Windows" : "/usr/bin:/bin:/usr/sbin:/sbin";

  let basePath =
    platform === process.platform && process.env.PATH
      ? process.env.PATH
      : platform === "win32" && process.platform !== "win32"
        ? defaultPath
        : process.env.PATH || defaultPath;

  const pathValue =
    options.runtimeDirectory && typeof options.runtimeDirectory === "string"
      ? `${options.runtimeDirectory}${delimiter}${basePath}`
      : basePath;

  const env = {
    PATH: pathValue,
    HOME: process.env.HOME || os.homedir(),
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
    LANG: process.env.LANG || "en_US.UTF-8",
    JOURNAL_DATA_DIR: dataDir,
  };

  if (platform === "win32") {
    const winKeys = [
      "SystemRoot",
      "SystemDrive",
      "TEMP",
      "TMP",
      "USERPROFILE",
      "APPDATA",
      "LOCALAPPDATA",
      "PATHEXT",
      "COMSPEC",
    ];
    for (const key of winKeys) {
      if (process.env[key]) {
        env[key] = process.env[key];
      }
    }
    if (!env.SystemRoot) env.SystemRoot = "C:\\Windows";
    if (!env.USERPROFILE) env.USERPROFILE = env.HOME;
    if (!env.TEMP) env.TEMP = env.TMPDIR;
    if (!env.TMP) env.TMP = env.TMPDIR;
  }

  return env;
}

/**
 * Resolves the bundled official Node runtime and launch.cjs entrypoint.
 * In a packaged application (MUST have bundled Node):
 *   Resources/runtime/node (or node.exe on Windows)
 *   Resources/launch.cjs
 * Development fallback ONLY when NOT packaged (no process.resourcesPath or dev env).
 * Packaged missing Node MUST FAIL - never fall back to process.execPath (Electron recursive backend).
 */
function resolveLaunchPaths(options = {}) {
  const platform = options.platform || process.platform;
  const isPackaged =
    options.resourcesPath !== undefined ? !!options.resourcesPath : !!process.resourcesPath;
  const resources =
    (options.resourcesPath !== undefined ? options.resourcesPath : process.resourcesPath) ||
    path.join(__dirname, "..");

  const nodeBinaryName = platform === "win32" ? "node.exe" : "node";
  const bundledNode = path.join(resources, "runtime", nodeBinaryName);
  const bundledLaunch = path.join(resources, "launch.cjs");

  if (fs.existsSync(bundledNode) && fs.existsSync(bundledLaunch)) {
    return {
      nodeExecutable: bundledNode,
      launchScript: bundledLaunch,
    };
  }

  // Packaged app missing bundled Node - MUST FAIL
  if (isPackaged) {
    throw new Error(
      `Packaged application missing bundled Node runtime at Resources/runtime/${nodeBinaryName}. Build failed to stage official Node.`,
    );
  }

  // Development / local fallback ONLY when not packaged
  return {
    nodeExecutable: process.execPath,
    launchScript: path.join(__dirname, "launch.cjs"),
  };
}

/**
 * Parses buffered child output to find the SUMI_READY signal and exact loopback origin.
 */
function parseSumiReady(line) {
  if (typeof line !== "string") return null;
  const match = line.match(/^SUMI_READY (http:\/\/127\.0\.0\.1:\d+)/);
  if (match) {
    return match[1];
  }
  return null;
}

/**
 * Builds the native menu template based on platform:
 * - macOS: Application menu (Sumi), Edit, View, Window
 * - Windows / Linux: File, Edit, View, Window, Help
 */
function buildMenuTemplate(dataDir, getMainWindow, platform = process.platform) {
  const isMac = platform === "darwin";

  const aboutItem = {
    label: "About Sumi",
    click: () => {
      const win = getMainWindow ? getMainWindow() : null;
      if (dialog) {
        dialog.showMessageBox(win, {
          type: "info",
          title: "Sumi",
          message: "Sumi",
          detail:
            "A local trading journal.\n\nBuilt on LuxAlgo's MIT-licensed Trade Journal, with a Kami-inspired theme (Tw93). Not affiliated with or endorsed by either project.\n\nThird-party license notices are bundled in Contents/Resources/licenses.",
        });
      }
    },
  };

  const showDataDirItem = {
    label: "Show Journal Data",
    click: () => {
      if (shell) {
        shell.openPath(dataDir);
      }
    },
  };

  if (isMac) {
    return [
      {
        label: "Sumi",
        submenu: [
          aboutItem,
          showDataDirItem,
          { type: "separator" },
          { role: "hide", label: "Hide Sumi" },
          { role: "hideOthers", label: "Hide Others" },
          { role: "unhide", label: "Show All" },
          { type: "separator" },
          { role: "quit", label: "Quit Sumi" },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { role: "forceReload" },
          { type: "separator" },
          { role: "resetZoom", label: "Actual Size" },
          { role: "zoomIn", label: "Zoom In" },
          { role: "zoomOut", label: "Zoom Out" },
        ],
      },
      {
        label: "Window",
        submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "close" }],
      },
    ];
  }

  // Windows and Linux menu template
  return [
    {
      label: "File",
      submenu: [showDataDirItem, { type: "separator" }, { role: "quit", label: "Exit" }],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { type: "separator" },
        { role: "resetZoom", label: "Actual Size" },
        { role: "zoomIn", label: "Zoom In" },
        { role: "zoomOut", label: "Zoom Out" },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "close" }],
    },
    {
      label: "Help",
      submenu: [aboutItem],
    },
  ];
}

/**
 * Hardened renderer webPreferences.
 * sandbox + contextIsolation ON, nodeIntegration OFF.
 */
const MAIN_WINDOW_WEB_PREFERENCES = Object.freeze({
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
});

/**
 * Registers all IPC handlers with exact origin and mainFrame validation.
 */
function registerIpcHandlers({
  ipcMainInstance,
  getMainWindow,
  getExpectedOrigin,
  preferencesStore,
  getUpdateService,
  shell: shellInstance,
  appVersion = "0.3.0",
}) {
  if (!ipcMainInstance) return;

  // 1. Synchronous preferences fetch for early preload cache (fast, no disk I/O)
  ipcMainInstance.on("sumi:get-preferences-sync", (event) => {
    const mainWindow = getMainWindow ? getMainWindow() : null;
    const origin = getExpectedOrigin ? getExpectedOrigin() : null;
    if (!isTrustedSender(event, mainWindow, origin)) {
      event.returnValue = {};
      return;
    }
    event.returnValue = preferencesStore ? preferencesStore.getPreferences() : {};
  });

  // 2. Asynchronous preferences save
  ipcMainInstance.on("sumi:save-preferences", (event, dict) => {
    const mainWindow = getMainWindow ? getMainWindow() : null;
    const origin = getExpectedOrigin ? getExpectedOrigin() : null;
    if (!isTrustedSender(event, mainWindow, origin)) {
      return;
    }
    if (preferencesStore) {
      preferencesStore.savePreferences(dict);
    }
  });

  // 3. App and runtime info
  ipcMainInstance.handle("sumi:get-info", async (event) => {
    const mainWindow = getMainWindow ? getMainWindow() : null;
    const origin = getExpectedOrigin ? getExpectedOrigin() : null;
    if (!isTrustedSender(event, mainWindow, origin)) {
      throw new Error("Unauthorized IPC invocation");
    }
    const updateService = getUpdateService ? getUpdateService() : null;
    return {
      version: appVersion,
      electronVersion: process.versions.electron || "",
      platform: process.platform,
      arch: process.arch,
      update:
        updateService && typeof updateService.getState === "function"
          ? updateService.getState()
          : { status: "idle" },
    };
  });

  // 4. Update check action (triggers Sparkle native update UI)
  ipcMainInstance.handle("sumi:check-for-updates", async (event) => {
    const mainWindow = getMainWindow ? getMainWindow() : null;
    const origin = getExpectedOrigin ? getExpectedOrigin() : null;
    if (!isTrustedSender(event, mainWindow, origin)) {
      throw new Error("Unauthorized IPC invocation");
    }
    const updateService = getUpdateService ? getUpdateService() : null;
    if (updateService && typeof updateService.check === "function") {
      return await updateService.check();
    }
    return { status: "idle" };
  });

  // 5. Deliberate external open brokered by the trusted preload click handler.
  // The popup (setWindowOpenHandler) always denies; only this restricted channel
  // can reach shell.openExternal, and only for a trusted main-frame sender with
  // a safe http/https/mailto URL (no credentials).
  ipcMainInstance.on("sumi:open-external", (event, url) => {
    const mainWindow = getMainWindow ? getMainWindow() : null;
    const origin = getExpectedOrigin ? getExpectedOrigin() : null;
    if (!isTrustedSender(event, mainWindow, origin)) {
      return;
    }
    if (!isSafeExternalUrl(url)) {
      return;
    }
    if (shellInstance && typeof shellInstance.openExternal === "function") {
      shellInstance.openExternal(url);
    }
  });
}

/**
 * Gracefully shuts down the backend child process:
 * - On all platforms: sends parent-owned IPC shutdown message
 * - On POSIX: sends standard graceful SIGTERM, then bounded SIGKILL fallback
 * - On Windows: SIGTERM is not graceful (TerminateProcess); uses IPC shutdown
 *   with bounded taskkill /T /F process-tree cleanup fallback
 */
async function stopChildProcess(child, options = {}) {
  if (!child) return "no_child";
  if (child.exitCode !== null || child.signalCode !== null || child.killed) {
    return "already_exited";
  }

  const platform = options.platform || process.platform;
  const timeoutMs = options.timeoutMs ?? 3000;

  return new Promise((resolve) => {
    let timer = null;
    let resolved = false;

    const onExit = () => {
      if (resolved) return;
      resolved = true;
      if (timer) clearTimeout(timer);
      resolve("stopped");
    };

    child.once("exit", onExit);

    // 1. Send parent-owned IPC shutdown message (graceful on all platforms)
    if (child.connected && typeof child.send === "function") {
      try {
        child.send({ type: "sumi:shutdown" });
      } catch {}
    }

    // 2. Also close stdin if open
    if (child.stdin && !child.stdin.destroyed) {
      try {
        child.stdin.end();
      } catch {}
    }

    // 3. On POSIX platforms, send standard graceful SIGTERM
    if (platform !== "win32") {
      try {
        child.kill("SIGTERM");
      } catch {
        if (timer) clearTimeout(timer);
        resolved = true;
        return resolve("stopped");
      }
    }

    // 4. Bounded fallback after timeoutMs
    timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        if (platform === "win32") {
          // On Windows, terminate the entire process tree
          try {
            if (typeof options.killProcessTree === "function") {
              options.killProcessTree(child.pid);
            } else {
              execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
                stdio: "ignore",
              });
            }
          } catch {
            try {
              child.kill();
            } catch {}
          }
        } else {
          try {
            child.kill("SIGKILL");
          } catch {}
        }
      }
      if (!resolved) {
        resolved = true;
        resolve("killed");
      }
    }, timeoutMs);
  });
}

// --------------------------------------------------------------------------
// Application Lifecycle Execution (when running inside Electron runtime)
// --------------------------------------------------------------------------

if (app && typeof app.whenReady === "function") {
  const isTestMode = process.env.SUMI_TEST_MODE === "1";
  const dataDir = resolveDataDirectory();

  // Create data directory with 0o700 permissions
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dataDir, 0o700);
  } catch {}

  // Key single instance lock to isolated userData directory
  const userDataDir = path.join(dataDir, "electron");
  fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(userDataDir, 0o700);
  } catch {}
  app.setPath("userData", userDataDir);

  const hasLock = app.requestSingleInstanceLock({ profile: userDataDir });
  if (!hasLock) {
    app.quit();
    process.exit(0);
  }

  const preferencesStore = createPreferencesStore({ dataDir, isTestMode });

  let mainWindow = null;
  let expectedOrigin = null;
  let childProcess = null;
  let securityController = null;
  let updateService = null;
  let isStopping = false;

  // Resolves once Electron is ready. Anything that needs `app` to be ready
  // (dialogs, windows, menus, sessions) must wait on this; the backend child
  // is spawned earlier so Next boots in parallel with Chromium init.
  const appReady = app.whenReady();

  function showErrorWhenReady(title, message) {
    return appReady.then(() => {
      dialog.showErrorBox(title, message);
    });
  }

  async function stopBackendChild() {
    if (!childProcess || isStopping) return;
    isStopping = true;
    const child = childProcess;
    childProcess = null;
    await stopChildProcess(child);
  }

  // Attempt to load update service if available from other owner
  try {
    const { createUpdateService } = require("./update-service.cjs");
    if (typeof createUpdateService === "function") {
      updateService = createUpdateService({
        app,
        getWindow: () => mainWindow,
        beforeInstall: async () => {
          await stopBackendChild();
        },
      });
    }
  } catch (err) {
    if (err.code !== "MODULE_NOT_FOUND") {
      console.error("[main] Failed to load update-service.cjs:", err);
    }
  }

  function startChildProcess() {
    const { nodeExecutable, launchScript } = resolveLaunchPaths();
    const runtimeDirectory = path.dirname(nodeExecutable);
    const env = buildChildEnv(dataDir, { runtimeDirectory });
    const logPath = path.join(dataDir, "desktop.log");

    let logFd;
    try {
      logFd = fs.openSync(logPath, "a", 0o600);
    } catch {
      logFd = null;
    }

    const child = spawn(nodeExecutable, [launchScript], {
      cwd: dataDir,
      env,
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });

    childProcess = child;
    let lineBuffer = "";

    const startupTimeout = setTimeout(() => {
      console.error("[main] Sumi local server startup timed out after 60s.");
      showErrorWhenReady(
        "Sumi could not open",
        "The local journal server did not become ready within 60 seconds. See desktop.log in your journal data folder.",
      )
        .then(() => stopBackendChild())
        .finally(() => {
          app.quit();
        });
    }, 60_000);

    const onData = (chunk) => {
      if (logFd !== null) {
        try {
          fs.writeSync(logFd, chunk);
        } catch {}
      }
      lineBuffer += chunk.toString("utf8");

      let newlineIndex;
      while ((newlineIndex = lineBuffer.indexOf("\n")) !== -1) {
        const line = lineBuffer.slice(0, newlineIndex).trim();
        lineBuffer = lineBuffer.slice(newlineIndex + 1);

        const readyOrigin = parseSumiReady(line);
        if (readyOrigin && !expectedOrigin) {
          expectedOrigin = readyOrigin;
          clearTimeout(startupTimeout);
          if (mainWindow) {
            mainWindow.loadURL(expectedOrigin);
          }
        }
      }

      if (lineBuffer.length > 16384) {
        lineBuffer = lineBuffer.slice(-16384);
      }
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    child.once("exit", (code, signal) => {
      clearTimeout(startupTimeout);
      if (logFd !== null) {
        try {
          fs.closeSync(logFd);
        } catch {}
      }
      if (!isStopping) {
        const exitDetail = code !== null ? `exit ${code}` : `signal ${signal}`;
        showErrorWhenReady(
          "Sumi could not open",
          `The local journal server stopped (${exitDetail}). Your data is still saved. See desktop.log in your journal data folder.`,
        ).finally(() => {
          app.quit();
        });
      }
    });
  }

  function createWindow() {
    mainWindow = new BrowserWindow({
      width: 1440,
      height: 920,
      minWidth: 900,
      minHeight: 620,
      title: "Sumi",
      backgroundColor: "#f5f4ed",
      webPreferences: {
        ...MAIN_WINDOW_WEB_PREFERENCES,
        preload: path.join(__dirname, "preload.cjs"),
      },
      show: false,
    });

    securityController = setupSecurityHandlers({
      mainWindow,
      getExpectedOrigin: () => expectedOrigin,
      shell,
      dialog,
      session: session.defaultSession,
      isTestMode,
    });

    const menu = Menu.buildFromTemplate(buildMenuTemplate(dataDir, () => mainWindow));
    Menu.setApplicationMenu(menu);

    mainWindow.once("ready-to-show", () => {
      mainWindow.show();
    });

    // The server may already be ready (it starts before the app is ready).
    if (expectedOrigin) {
      mainWindow.loadURL(expectedOrigin);
      return;
    }

    // Initial splash page while server starts
    mainWindow.loadURL(
      "data:text/html;charset=utf-8," +
        encodeURIComponent(`
        <html><body style="background:#f5f4ed;color:#1b365d;display:grid;place-content:center;height:90vh;text-align:center;font-family:Georgia,serif">
        <h1 style="font-weight:400;font-size:40px;margin-bottom:12px">Sumi</h1>
        <p style="color:#6b6a64">Opening your trading journal…</p></body></html>
      `),
    );
  }

  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on("activate", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  registerIpcHandlers({
    ipcMainInstance: ipcMain,
    getMainWindow: () => mainWindow,
    getExpectedOrigin: () => expectedOrigin,
    preferencesStore,
    getUpdateService: () => updateService,
    shell,
    appVersion: app.getVersion() || "0.3.0",
  });

  // Start the local server now, in parallel with Electron/Chromium init.
  try {
    startChildProcess();
  } catch (err) {
    console.error("[main] Failed to start the local server:", err);
    showErrorWhenReady(
      "Sumi could not open",
      `The local journal server could not be started (${err && err.message ? err.message : err}).`,
    ).finally(() => {
      app.quit();
    });
  }

  // Last resort if the app exits before the async before-quit cleanup ran.
  process.on("exit", () => {
    if (childProcess) {
      try {
        childProcess.kill();
      } catch {}
    }
  });

  appReady.then(() => {
    createWindow();
  });

  let beforeQuitHandled = false;
  app.on("before-quit", (event) => {
    if (!beforeQuitHandled) {
      beforeQuitHandled = true;
      event.preventDefault();

      if (securityController) {
        securityController.cancelActiveDownloads();
      }

      if (updateService && typeof updateService.dispose === "function") {
        try {
          updateService.dispose();
        } catch {}
      }

      stopBackendChild().finally(() => {
        app.quit();
      });
    }
  });

  app.on("window-all-closed", () => {
    app.quit();
  });
}

module.exports = {
  MAIN_WINDOW_WEB_PREFERENCES,
  buildChildEnv,
  resolveLaunchPaths,
  parseSumiReady,
  buildMenuTemplate,
  registerIpcHandlers,
  stopChildProcess,
};
