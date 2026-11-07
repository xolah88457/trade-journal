import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  MAIN_WINDOW_WEB_PREFERENCES,
  buildChildEnv,
  parseSumiReady,
  buildMenuTemplate,
  registerIpcHandlers,
  resolveLaunchPaths,
} from "./main.cjs";

test("buildChildEnv strictly whitelists environment and strips NODE_OPTIONS and secrets", () => {
  const origEnv = { ...process.env };
  try {
    process.env.NODE_OPTIONS = "--inspect=9229 --max-old-space-size=4096";
    process.env.OPENAI_API_KEY = "sk-super-secret-key";
    process.env.AWS_SECRET_ACCESS_KEY = "secret";
    process.env.SOME_RANDOM_FLAG = "flag";

    const dataDir = "/Users/test/Library/Application Support/Sumi";
    const env = buildChildEnv(dataDir);

    // Whitelisted keys present
    assert.equal(env.JOURNAL_DATA_DIR, dataDir);
    assert.ok(env.PATH);
    assert.ok(env.HOME);
    assert.ok(env.TMPDIR);
    assert.ok(env.LANG);

    // Forbidden keys strictly absent
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(env.SOME_RANDOM_FLAG, undefined);
  } finally {
    process.env = origEnv;
  }
});

test("parseSumiReady parses exact loopback origin and rejects arbitrary output", () => {
  assert.equal(parseSumiReady("SUMI_READY http://127.0.0.1:45678"), "http://127.0.0.1:45678");
  assert.equal(parseSumiReady("SUMI_READY http://127.0.0.1:3000\n"), "http://127.0.0.1:3000");

  // Rejects invalid lines
  assert.equal(parseSumiReady("Ready on port 3000"), null);
  assert.equal(parseSumiReady("SUMI_READY http://localhost:3000"), null);
  assert.equal(parseSumiReady("SUMI_READY https://127.0.0.1:3000"), null);
  assert.equal(parseSumiReady("SUMI_READY not-a-url"), null);
  assert.equal(parseSumiReady(""), null);
  assert.equal(parseSumiReady(null), null);
});

test("buildMenuTemplate includes standard macOS Edit, View, Window and Sumi items", () => {
  const template = buildMenuTemplate("/tmp/data-dir", () => null);
  const labels = template.map((m) => m.label);
  assert.deepEqual(labels, ["Sumi", "Edit", "View", "Window"]);

  // Verify Edit commands
  const editMenu = template.find((m) => m.label === "Edit");
  const editRoles = editMenu.submenu.map((s) => s.role).filter(Boolean);
  assert.ok(editRoles.includes("undo"));
  assert.ok(editRoles.includes("redo"));
  assert.ok(editRoles.includes("cut"));
  assert.ok(editRoles.includes("copy"));
  assert.ok(editRoles.includes("paste"));
  assert.ok(editRoles.includes("selectAll"));

  // Verify View commands
  const viewMenu = template.find((m) => m.label === "View");
  const viewRoles = viewMenu.submenu.map((s) => s.role).filter(Boolean);
  assert.ok(viewRoles.includes("reload"));
  assert.ok(viewRoles.includes("resetZoom"));
  assert.ok(viewRoles.includes("zoomIn"));
  assert.ok(viewRoles.includes("zoomOut"));

  // Verify Sumi actions
  const sumiMenu = template.find((m) => m.label === "Sumi");
  const sumiLabels = sumiMenu.submenu.map((s) => s.label).filter(Boolean);
  assert.ok(sumiLabels.includes("About Sumi"));
  assert.ok(sumiLabels.includes("Show Journal Data"));
});

test("registerIpcHandlers registers IPC dispatchers with security validation", async () => {
  const syncHandlers = new Map();
  const asyncHandlers = new Map();

  const mockIpcMain = {
    on(channel, handler) {
      syncHandlers.set(channel, handler);
    },
    handle(channel, handler) {
      asyncHandlers.set(channel, handler);
    },
  };

  const expectedOrigin = "http://127.0.0.1:45678";
  const mainFrame = {
    url: `${expectedOrigin}/journal`,
    parent: null,
  };
  const mockWebContents = {
    mainFrame,
  };
  const mockMainWindow = {
    webContents: mockWebContents,
  };

  let savedPrefDict = null;
  const mockStore = {
    getPreferences: () => ({ "journal-theme-v1": "dark" }),
    savePreferences: (dict) => {
      savedPrefDict = dict;
    },
  };

  const updateState = { status: "available", version: "0.2.1" };
  const mockUpdateService = {
    getState: () => updateState,
    check: async () => ({ status: "available" }),
    dispose: () => {},
  };

  const shellOpened = [];
  const mockShell = {
    openExternal(url) {
      shellOpened.push(url);
    },
  };

  registerIpcHandlers({
    ipcMainInstance: mockIpcMain,
    getMainWindow: () => mockMainWindow,
    getExpectedOrigin: () => expectedOrigin,
    preferencesStore: mockStore,
    getUpdateService: () => mockUpdateService,
    shell: mockShell,
    appVersion: "0.2.0",
  });

  // 1. sumi:get-preferences-sync
  const getPrefHandler = syncHandlers.get("sumi:get-preferences-sync");
  assert.ok(getPrefHandler);

  // Untrusted sender gets empty object
  const untrustedEvent = {
    sender: { mainFrame },
    senderFrame: mainFrame,
  };
  getPrefHandler(untrustedEvent);
  assert.deepEqual(untrustedEvent.returnValue, {});

  // Trusted sender gets cached preferences
  const trustedEvent = {
    sender: mockWebContents,
    senderFrame: mainFrame,
  };
  getPrefHandler(trustedEvent);
  assert.deepEqual(trustedEvent.returnValue, { "journal-theme-v1": "dark" });

  // 2. sumi:save-preferences
  const savePrefHandler = syncHandlers.get("sumi:save-preferences");
  assert.ok(savePrefHandler);

  // Untrusted sender rejected
  savePrefHandler(untrustedEvent, { "journal-theme-v1": "light" });
  assert.equal(savedPrefDict, null);

  // Trusted sender accepted
  savePrefHandler(trustedEvent, { "journal-theme-v1": "light" });
  assert.deepEqual(savedPrefDict, { "journal-theme-v1": "light" });

  // 3. sumi:get-info
  const getInfoHandler = asyncHandlers.get("sumi:get-info");
  assert.ok(getInfoHandler);

  await assert.rejects(
    async () => await getInfoHandler(untrustedEvent),
    /Unauthorized IPC invocation/,
  );

  const info = await getInfoHandler(trustedEvent);
  assert.equal(info.version, "0.2.0");
  assert.equal(info.platform, process.platform);
  assert.equal(info.arch, process.arch);
  assert.deepEqual(info.update, updateState);

  // 4. Update check action dispatcher
  const checkHandler = asyncHandlers.get("sumi:check-for-updates");
  assert.deepEqual(await checkHandler(trustedEvent), { status: "available" });
  assert.equal(asyncHandlers.has("sumi:download-update"), false);
  assert.equal(asyncHandlers.has("sumi:install-update"), false);

  // 5. Restricted external-open channel: only trusted main-frame senders with
  // safe http/https/mailto URLs reach shell.openExternal
  const openExternalHandler = syncHandlers.get("sumi:open-external");
  assert.ok(openExternalHandler);

  // Trusted sender + safe https URL -> opened
  openExternalHandler(trustedEvent, "https://github.com/LuxAlgo/trade-journal");
  assert.deepEqual(shellOpened, ["https://github.com/LuxAlgo/trade-journal"]);

  // Trusted sender + mailto -> opened
  openExternalHandler(trustedEvent, "mailto:support@sumi.local");
  assert.deepEqual(shellOpened.length, 2);

  // Trusted sender + unsafe URL -> NOT opened
  openExternalHandler(trustedEvent, "file:///etc/passwd");
  openExternalHandler(trustedEvent, "javascript:alert(1)");
  openExternalHandler(trustedEvent, "https://user:pass@evil.com/");
  openExternalHandler(trustedEvent, 42);
  assert.deepEqual(shellOpened.length, 2);

  // Trusted sender + any credential-free https URL -> opened (deliberate user navigation)
  openExternalHandler(trustedEvent, "https://example.com/docs");
  assert.deepEqual(shellOpened.length, 3);

  // Untrusted sender + safe URL -> NOT opened
  openExternalHandler(untrustedEvent, "https://example.com/");
  assert.deepEqual(shellOpened.length, 3);
});

test("main window webPreferences are hardened: sandbox + contextIsolation on, nodeIntegration off", () => {
  assert.equal(MAIN_WINDOW_WEB_PREFERENCES.sandbox, true);
  assert.equal(MAIN_WINDOW_WEB_PREFERENCES.contextIsolation, true);
  assert.equal(MAIN_WINDOW_WEB_PREFERENCES.nodeIntegration, false);
  assert.equal(MAIN_WINDOW_WEB_PREFERENCES.webSecurity, true);
});

test("resolveLaunchPaths returns bundled Node in packaged app and fails if missing", () => {
  // Simulate packaged app (process.resourcesPath exists)
  const origResourcesPath = process.resourcesPath;
  const origExecPath = process.execPath;
  try {
    // Create a temporary directory structure mimicking a packaged app
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-launch-test-"));
    const resourcesDir = path.join(tmpDir, "Resources");
    const runtimeDir = path.join(resourcesDir, "runtime");
    fs.mkdirSync(runtimeDir, { recursive: true });

    // Test 1: Packaged app WITH bundled Node -> returns bundled paths
    const bundledNode = path.join(runtimeDir, "node");
    const bundledLaunch = path.join(resourcesDir, "launch.cjs");
    fs.writeFileSync(bundledNode, "#! /bin/sh\necho mock node");
    fs.chmodSync(bundledNode, 0o755);
    fs.writeFileSync(bundledLaunch, "console.log('launch')");

    process.resourcesPath = resourcesDir;
    const paths = resolveLaunchPaths();
    assert.equal(paths.nodeExecutable, bundledNode);
    assert.equal(paths.launchScript, bundledLaunch);

    // Test 2: Packaged app WITHOUT bundled Node -> THROWS
    fs.rmSync(bundledNode);
    fs.rmSync(bundledLaunch);
    assert.throws(() => resolveLaunchPaths(), /Packaged application missing bundled Node runtime/);

    // Test 3: Development mode (no process.resourcesPath) -> falls back to process.execPath
    process.resourcesPath = undefined;
    const devPaths = resolveLaunchPaths();
    assert.equal(devPaths.nodeExecutable, process.execPath);
    assert.ok(devPaths.launchScript.endsWith("launch.cjs"));

    fs.rmSync(tmpDir, { recursive: true, force: true });
  } finally {
    process.resourcesPath = origResourcesPath;
    // process.execPath is read-only in some environments, don't restore
  }
});

test("buildChildEnv on Windows whitelists essential system variables and strips secrets", () => {
  const origEnv = { ...process.env };
  try {
    process.env.SystemRoot = "C:\\Windows";
    process.env.USERPROFILE = "C:\\Users\\alice";
    process.env.TEMP = "C:\\Users\\alice\\AppData\\Local\\Temp";
    process.env.NODE_OPTIONS = "--inspect=9229";
    process.env.OPENAI_API_KEY = "sk-super-secret";

    const dataDir = "C:\\Users\\alice\\AppData\\Roaming\\Sumi";
    const env = buildChildEnv(dataDir, { platform: "win32" });

    // Essential Windows keys present
    assert.equal(env.JOURNAL_DATA_DIR, dataDir);
    assert.equal(env.SystemRoot, "C:\\Windows");
    assert.equal(env.USERPROFILE, "C:\\Users\\alice");
    assert.equal(env.TEMP, "C:\\Users\\alice\\AppData\\Local\\Temp");
    assert.ok(env.PATH);

    // Forbidden keys strictly stripped
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.OPENAI_API_KEY, undefined);
  } finally {
    process.env = origEnv;
  }
});

test("buildChildEnv prepends runtimeDirectory with semicolon and handles path spaces on Windows", () => {
  const origEnv = { ...process.env };
  try {
    process.env.SystemRoot = "C:\\Windows";
    process.env.USERPROFILE = "C:\\Users\\alice";
    process.env.TEMP = "C:\\Users\\alice\\AppData\\Local\\Temp";
    process.env.NODE_OPTIONS = "--inspect=9229";
    process.env.OPENAI_API_KEY = "sk-super-secret";

    const dataDir = "C:\\Users\\alice\\AppData\\Roaming\\Sumi";
    const runtimeWithSpaces = "C:\\Program Files\\Sumi\\resources\\runtime";

    // 1. Pure Windows with runtimeDirectory containing spaces: must prepend with semicolon
    const winEnv = buildChildEnv(dataDir, {
      platform: "win32",
      runtimeDirectory: runtimeWithSpaces,
    });
    assert.ok(
      winEnv.PATH.startsWith(`${runtimeWithSpaces};`),
      `Windows PATH must prepend runtimeDirectory with semicolon, got: ${winEnv.PATH}`,
    );
    assert.ok(
      winEnv.PATH.includes("C:\\Windows\\System32"),
      "Windows PATH must retain standard system path",
    );

    // 2. POSIX unchanged when runtimeDirectory omitted
    const posixDefault = buildChildEnv("/tmp/sumi-data", { platform: "darwin" });
    assert.equal(
      posixDefault.PATH,
      process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin",
      "POSIX PATH without runtimeDirectory must remain unchanged",
    );

    // 3. POSIX prepends with colon when runtimeDirectory provided
    const posixWithRuntime = buildChildEnv("/tmp/sumi-data", {
      platform: "darwin",
      runtimeDirectory: "/opt/Sumi App/runtime",
    });
    assert.ok(
      posixWithRuntime.PATH.startsWith("/opt/Sumi App/runtime:"),
      "POSIX PATH must prepend runtimeDirectory with colon delimiter",
    );

    // Whitelist and secret stripping hold
    assert.equal(winEnv.JOURNAL_DATA_DIR, dataDir);
    assert.equal(winEnv.NODE_OPTIONS, undefined);
    assert.equal(winEnv.OPENAI_API_KEY, undefined);
  } finally {
    process.env = origEnv;
  }
});

test("resolveLaunchPaths resolves node.exe on Windows and node on Unix in packaged apps", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-launch-win-"));
  const resourcesDir = path.join(tmpDir, "Resources");
  const runtimeDir = path.join(resourcesDir, "runtime");
  fs.mkdirSync(runtimeDir, { recursive: true });

  try {
    const bundledNodeWin = path.join(runtimeDir, "node.exe");
    const bundledNodeUnix = path.join(runtimeDir, "node");
    const bundledLaunch = path.join(resourcesDir, "launch.cjs");
    fs.writeFileSync(bundledNodeWin, "mock node exe");
    fs.writeFileSync(bundledNodeUnix, "mock node unix");
    fs.writeFileSync(bundledLaunch, "console.log('launch')");

    // Windows resolves node.exe
    const winPaths = resolveLaunchPaths({
      platform: "win32",
      resourcesPath: resourcesDir,
    });
    assert.equal(winPaths.nodeExecutable, bundledNodeWin);
    assert.equal(winPaths.launchScript, bundledLaunch);

    // Linux resolves node
    const linuxPaths = resolveLaunchPaths({
      platform: "linux",
      resourcesPath: resourcesDir,
    });
    assert.equal(linuxPaths.nodeExecutable, bundledNodeUnix);
    assert.equal(linuxPaths.launchScript, bundledLaunch);

    // Windows missing node.exe throws specific message
    fs.rmSync(bundledNodeWin);
    assert.throws(
      () =>
        resolveLaunchPaths({
          platform: "win32",
          resourcesPath: resourcesDir,
        }),
      /Packaged application missing bundled Node runtime at Resources[/\\]runtime[/\\]node\.exe/,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("buildMenuTemplate adapts for Windows and Linux with File and Help menus", () => {
  for (const plat of ["win32", "linux"]) {
    const template = buildMenuTemplate("/tmp/sumi-data", () => null, plat);
    const labels = template.map((m) => m.label);
    assert.deepEqual(labels, ["File", "Edit", "View", "Window", "Help"]);

    // File menu has Show Journal Data and Exit
    const fileMenu = template.find((m) => m.label === "File");
    const fileLabels = fileMenu.submenu.map((s) => s.label).filter(Boolean);
    assert.ok(fileLabels.includes("Show Journal Data"));
    assert.ok(fileLabels.includes("Exit"));
    const exitItem = fileMenu.submenu.find((s) => s.label === "Exit");
    assert.equal(exitItem.role, "quit");

    // Help menu has About Sumi
    const helpMenu = template.find((m) => m.label === "Help");
    const helpLabels = helpMenu.submenu.map((s) => s.label).filter(Boolean);
    assert.ok(helpLabels.includes("About Sumi"));
  }
});
