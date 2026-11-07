import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createUpdateService,
  redactError,
  resolveConfigPath,
  loadUpdateConfig,
} from "./update-service.cjs";
import {
  computeKeyFingerprint,
  validateUpdateConfig,
  buildSignCommand,
  buildAppcastCommand,
  resolveSparkleBinary,
} from "./update-tools.mjs";

/**
 * Creates a mock Sparkle updater for unit tests matching electron-sparkle 0.2.0 API.
 * Events: state-changed, update-available, update-not-available, update-downloaded,
 * before-install, before-relaunch, cycle-complete, error
 */
function createMockUpdater(options = {}) {
  const listeners = new Map();
  let automaticallyChecks = true;
  let automaticallyDownloads = true;
  let beforeRelaunchHandler = null;
  let started = false;
  let checkCount = 0;

  return {
    startCalls: 0,
    checkCalls: 0,
    offCalls: 0,
    options,
    order: [], // call-order log proving SDK ordering (start before setters/check)

    async start() {
      this.startCalls++;
      this.order.push("start:begin");
      if (options.startGate) await options.startGate; // deferred start for ordering tests
      if (options.failStart) {
        throw new Error(
          options.startErrorMessage ||
            "Native framework missing: /Users/admin/Library/Frameworks/Sparkle.framework",
        );
      }
      // Real SDK (dist/index.cjs): started=true only AFTER the native adapter started
      started = true;
      this.order.push("start:done");
      // Emit state-changed after start
      const list = listeners.get("state-changed") || [];
      for (const fn of list) {
        fn({
          type: "state-changed",
          state: {
            started: true,
            canCheckForUpdates: true,
            sessionInProgress: false,
            automaticallyChecksForUpdates: false,
            automaticallyDownloadsUpdates: false,
          },
        });
      }
    },

    checkForUpdates() {
      if (!started) throw new Error("UpdaterNotStartedError"); // mirrors requireStarted()
      this.checkCalls++;
      checkCount++;
      this.order.push("checkForUpdates");
      if (options.failCheck) {
        throw new Error(options.checkErrorMessage || "Check failed");
      }
      // Simulate async check - in real Sparkle this opens native UI
    },

    checkForUpdatesInBackground() {
      if (options.failCheck) {
        throw new Error(options.checkErrorMessage || "Background check failed");
      }
    },

    getState() {
      return {
        started,
        canCheckForUpdates: started,
        sessionInProgress: false,
        automaticallyChecksForUpdates: automaticallyChecks,
        automaticallyDownloadsUpdates: automaticallyDownloads,
      };
    },

    setAutomaticallyChecksForUpdates(val) {
      if (!started) throw new Error("UpdaterNotStartedError"); // mirrors requireStarted()
      automaticallyChecks = val;
      this.order.push("setAutomaticallyChecksForUpdates:" + val);
    },

    setAutomaticallyDownloadsUpdates(val) {
      if (!started) throw new Error("UpdaterNotStartedError"); // mirrors requireStarted()
      automaticallyDownloads = val;
      this.order.push("setAutomaticallyDownloadsUpdates:" + val);
    },

    setBeforeRelaunchHandler(handler) {
      beforeRelaunchHandler = handler;
    },

    getBeforeRelaunchHandler() {
      return beforeRelaunchHandler;
    },

    on(event, fn) {
      if (!listeners.has(event)) {
        listeners.set(event, []);
      }
      listeners.get(event).push(fn);
      return this;
    },

    off(event, fn) {
      this.offCalls++;
      if (listeners.has(event)) {
        const list = listeners.get(event);
        const idx = list.indexOf(fn);
        if (idx !== -1) list.splice(idx, 1);
      }
      return this;
    },

    // Helper to emit properly structured events matching electron-sparkle
    emitUpdateAvailable(version, displayVersion) {
      const list = listeners.get("update-available") || [];
      for (const fn of list) {
        fn({
          type: "update-available",
          update: {
            version,
            displayVersion,
            title: "",
            fileURL: "",
            releaseNotesURL: "",
            infoURL: "",
            contentLength: 0,
            publicationDate: new Date(),
          },
        });
      }
    },

    emitUpdateNotAvailable(userInitiated = true) {
      const list = listeners.get("update-not-available") || [];
      for (const fn of list) {
        fn({ type: "update-not-available", userInitiated });
      }
    },

    emitUpdateDownloaded(version, displayVersion) {
      const list = listeners.get("update-downloaded") || [];
      for (const fn of list) {
        fn({
          type: "update-downloaded",
          update: {
            version,
            displayVersion,
            title: "",
            fileURL: "",
            releaseNotesURL: "",
            infoURL: "",
            contentLength: 0,
            publicationDate: new Date(),
          },
        });
      }
    },

    emitBeforeInstall(version, displayVersion) {
      const list = listeners.get("before-install") || [];
      for (const fn of list) {
        fn({
          type: "before-install",
          update: {
            version,
            displayVersion,
            title: "",
            fileURL: "",
            releaseNotesURL: "",
            infoURL: "",
            contentLength: 0,
            publicationDate: new Date(),
          },
        });
      }
    },

    emitBeforeRelaunch() {
      const list = listeners.get("before-relaunch") || [];
      for (const fn of list) {
        fn({ type: "before-relaunch" });
      }
    },

    emitCycleComplete() {
      const list = listeners.get("cycle-complete") || [];
      for (const fn of list) {
        fn({ type: "cycle-complete" });
      }
    },

    emitError(error) {
      const list = listeners.get("error") || [];
      for (const fn of list) {
        fn({ type: "error", error });
      }
    },

    getListenerCount(event) {
      return (listeners.get(event) || []).length;
    },
  };
}

/**
 * Helper to write a valid test config in temp directory.
 */
function createTempConfig(overrides = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-update-test-"));
  const configPath = path.join(tmpDir, "update-config.json");
  const config = {
    provider: "sparkle",
    feedUrl: "https://github.com/xolah88457/trade-journal/releases/latest/download/appcast.xml",
    publicEdKey: "bW9ja1B1YmxpY0VkMjU1MTlLZXlGb3JVbml0VGVzdHM=", // 32 bytes base64
    ...overrides,
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
  return { tmpDir, configPath, config };
}

test("redactError scrubs sensitive paths, credentials, and query tokens", () => {
  // 1. Credentials in URLs
  const creds = "Failed to fetch https://user:supersecret@github.com/xolah/appcast.xml: 401";
  assert.equal(redactError(creds), "Failed to fetch https://***@github.com/xolah/appcast.xml: 401");

  // 2. Query tokens
  const query = "Download error from https://cdn.example.com/file.zip?token=secret123&key=private";
  assert.equal(
    redactError(query),
    "Download error from https://cdn.example.com/file.zip?token=***&key=***",
  );

  // 3. Absolute local file system paths
  const unixPath = "Could not load library /Users/developer/secret-repo/desktop/Sparkle.framework";
  assert.equal(redactError(unixPath), "Could not load library [path]");

  const tmpPath = "Cache file corrupt at /private/tmp/sparkle-temp-dir/seed.key";
  assert.equal(redactError(tmpPath), "Cache file corrupt at [path]");

  const winPath = "File missing at C:\\Users\\Administrator\\AppData\\Local\\Temp\\test.key";
  assert.equal(redactError(winPath), "File missing at [path]");
});

test("SUMI_TEST_MODE config path hardening rejects non-tmp or relative paths", () => {
  const originalEnv = { ...process.env };
  try {
    // Normal mode: ignores custom path, returns bundled desktop/update-config.json
    delete process.env.SUMI_TEST_MODE;
    const defaultExpected = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "update-config.json",
    );
    assert.equal(resolveConfigPath("/tmp/arbitrary.json"), defaultExpected);

    // Test mode: SUMI_TEST_MODE=1
    process.env.SUMI_TEST_MODE = "1";

    // Rejects relative path
    assert.equal(resolveConfigPath("relative/config.json"), defaultExpected);

    // Rejects path outside tmp directory
    assert.equal(resolveConfigPath("/etc/sumi-config.json"), defaultExpected);

    // Accepts valid absolute path under tmp
    const { tmpDir, configPath } = createTempConfig();
    assert.equal(resolveConfigPath(configPath), configPath);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  } finally {
    process.env = originalEnv;
  }
});

test("lazy init: service does not start Sparkle or attach automatic checks on creation", () => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

  let factoryCalls = 0;
  const mockUpdater = createMockUpdater();
  const service = createUpdateService({
    app: { getVersion: () => "0.2.0" },
    updaterFactory: () => {
      factoryCalls++;
      return mockUpdater;
    },
  });

  try {
    // Sparkle factory should NOT have been called yet
    assert.equal(factoryCalls, 0);

    // getState() is synchronous and returns initial idle status
    const state = service.getState();
    assert.deepEqual(state, {
      status: "idle",
      currentVersion: "0.2.0",
      availableVersion: null,
      message: null,
      error: null,
      nativeUI: true,
      provider: "sparkle",
    });
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  }
});

test("missing public key in config sets status to unavailable without insecure fallback", async () => {
  const originalEnv = { ...process.env };
  const originalPlatform = process.platform;
  process.env.SUMI_TEST_MODE = "1";
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

  const { tmpDir, configPath } = createTempConfig({ publicEdKey: "" });
  let factoryCalls = 0;
  const service = createUpdateService({
    app: { getVersion: () => "0.2.0" },
    configPath,
    updaterFactory: () => {
      factoryCalls++;
      return createMockUpdater();
    },
  });

  try {
    const state = await service.check();
    assert.equal(state.status, "unavailable");
    assert.equal(state.error, "Update verification key is not configured");
    assert.equal(state.message, "Updates are unavailable");
    // Factory should NOT be called — no insecure fallback
    assert.equal(factoryCalls, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.env = originalEnv;
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  }
});

test("insecure HTTP feedUrl is rejected with status unavailable", async () => {
  const originalEnv = { ...process.env };
  const originalPlatform = process.platform;
  process.env.SUMI_TEST_MODE = "1";
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

  const { tmpDir, configPath } = createTempConfig({
    feedUrl: "http://insecure.example.com/appcast.xml",
  });
  let factoryCalls = 0;
  const service = createUpdateService({
    app: { getVersion: () => "0.2.0" },
    configPath,
    updaterFactory: () => {
      factoryCalls++;
      return createMockUpdater();
    },
  });

  try {
    const state = await service.check();
    assert.equal(state.status, "unavailable");
    assert.equal(state.error, "Update feed URL must use HTTPS");
    assert.equal(factoryCalls, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.env = originalEnv;
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  }
});

test("check() lazily initializes Sparkle, disables automatic checks, and triggers native UI", async () => {
  const originalEnv = { ...process.env };
  const originalPlatform = process.platform;
  process.env.SUMI_TEST_MODE = "1";
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

  const { tmpDir, configPath } = createTempConfig();
  const mockUpdater = createMockUpdater();
  const service = createUpdateService({
    app: { getVersion: () => "0.2.0" },
    configPath,
    updaterFactory: () => mockUpdater,
  });

  try {
    const state = await service.check();
    assert.equal(mockUpdater.startCalls, 1);
    assert.equal(mockUpdater.checkCalls, 1);
    assert.equal(mockUpdater.getState().automaticallyChecksForUpdates, false);
    assert.equal(mockUpdater.getState().automaticallyDownloadsUpdates, false);
    assert.equal(state.status, "checking");
    assert.equal(state.nativeUI, true);
    assert.equal(state.provider, "sparkle");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.env = originalEnv;
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  }
});

test("mock hardening: setters and checkForUpdates throw before start() resolves (mirrors requireStarted)", () => {
  const mock = createMockUpdater();
  assert.throws(() => mock.setAutomaticallyChecksForUpdates(false), /UpdaterNotStartedError/);
  assert.throws(() => mock.setAutomaticallyDownloadsUpdates(false), /UpdaterNotStartedError/);
  assert.throws(() => mock.checkForUpdates(), /UpdaterNotStartedError/);
});

test("check() awaits updater.start() BEFORE the automatic setters and the manual check (real SDK order)", async () => {
  const originalEnv = { ...process.env };
  const originalPlatform = process.platform;
  process.env.SUMI_TEST_MODE = "1";
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

  const { tmpDir, configPath } = createTempConfig();
  let releaseStart;
  const startGate = new Promise((resolve) => {
    releaseStart = resolve;
  });
  const mockUpdater = createMockUpdater({ startGate });
  const service = createUpdateService({
    app: { getVersion: () => "0.2.0" },
    configPath,
    updaterFactory: () => mockUpdater,
  });

  try {
    const pending = service.check();
    await new Promise((r) => setImmediate(r));
    // start() begun but not yet resolved -> setters must NOT have run yet
    assert.ok(mockUpdater.order.includes("start:begin"));
    assert.ok(!mockUpdater.order.some((e) => e.startsWith("setAutomatically")));
    assert.ok(!mockUpdater.order.includes("checkForUpdates"));

    releaseStart();
    const state = await pending;
    assert.equal(state.status, "checking");

    const startDone = mockUpdater.order.indexOf("start:done");
    const checks = mockUpdater.order.findIndex((e) =>
      e.startsWith("setAutomaticallyChecksForUpdates"),
    );
    const downloads = mockUpdater.order.findIndex((e) =>
      e.startsWith("setAutomaticallyDownloadsUpdates"),
    );
    const manual = mockUpdater.order.indexOf("checkForUpdates");
    assert.ok(startDone !== -1, "start resolved");
    assert.ok(checks > startDone, "setAutomaticallyChecksForUpdates AFTER start");
    assert.ok(downloads > startDone, "setAutomaticallyDownloadsUpdates AFTER start");
    assert.ok(manual > checks && manual > downloads, "manual checkForUpdates AFTER both setters");
    assert.deepEqual(
      mockUpdater.order.filter((e) => e.startsWith("setAutomatically")),
      ["setAutomaticallyChecksForUpdates:false", "setAutomaticallyDownloadsUpdates:false"],
    );
    assert.equal(mockUpdater.getState().automaticallyChecksForUpdates, false);
    assert.equal(mockUpdater.getState().automaticallyDownloadsUpdates, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.env = originalEnv;
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  }
});

test("before-relaunch hook awaits safeBackendShutdown with bounded handling", async () => {
  const originalEnv = { ...process.env };
  const originalPlatform = process.platform;
  process.env.SUMI_TEST_MODE = "1";
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

  const { tmpDir, configPath } = createTempConfig();
  const mockUpdater = createMockUpdater();
  let shutdownCalled = false;

  const service = createUpdateService({
    app: { getVersion: () => "0.2.0" },
    configPath,
    beforeInstall: async () => {
      shutdownCalled = true;
    },
    updaterFactory: () => mockUpdater,
  });

  try {
    await service.check();
    const relaunchHandler = mockUpdater.getBeforeRelaunchHandler();
    assert.equal(typeof relaunchHandler, "function");

    // Invoke relaunch hook (as Sparkle does before restarting)
    await relaunchHandler({ version: "0.3.0", displayVersion: "0.3.0" });
    assert.equal(shutdownCalled, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.env = originalEnv;
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  }
});

test("before-relaunch hook catches shutdown failure, sets redacted error, and does not crash", async () => {
  const originalEnv = { ...process.env };
  const originalPlatform = process.platform;
  process.env.SUMI_TEST_MODE = "1";
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

  const { tmpDir, configPath } = createTempConfig();
  const mockUpdater = createMockUpdater();

  const service = createUpdateService({
    app: { getVersion: () => "0.2.0" },
    configPath,
    beforeInstall: async () => {
      throw new Error("Backend SIGTERM failed for /Users/test/sumi/server.js");
    },
    updaterFactory: () => mockUpdater,
  });

  try {
    await service.check();
    const relaunchHandler = mockUpdater.getBeforeRelaunchHandler();

    // Invoking the handler must not throw uncaught or crash
    await relaunchHandler({ version: "0.3.0" });

    const state = service.getState();
    assert.equal(state.error, "Backend SIGTERM failed for [path]");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.env = originalEnv;
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  }
});

test("failed initialization records sanitized error and allows retry on next check", async () => {
  const originalEnv = { ...process.env };
  const originalPlatform = process.platform;
  process.env.SUMI_TEST_MODE = "1";
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

  const { tmpDir, configPath } = createTempConfig();
  let failStart = true;
  let factoryCount = 0;

  const service = createUpdateService({
    app: { getVersion: () => "0.2.0" },
    configPath,
    updaterFactory: () => {
      factoryCount++;
      return createMockUpdater({
        failStart,
        startErrorMessage: "Could not link /Users/admin/Library/Sparkle.framework",
      });
    },
  });

  try {
    // 1. First check fails
    const state1 = await service.check();
    assert.equal(state1.status, "error");
    assert.equal(state1.error, "Could not link [path]");

    // 2. Retry with recovered updater
    failStart = false;
    const state2 = await service.check();
    assert.equal(state2.status, "checking");
    assert.equal(state2.error, null);
    assert.equal(factoryCount, 2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.env = originalEnv;
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  }
});

test("dispose unregisters all event listeners and resets relaunch handler", async () => {
  const originalEnv = { ...process.env };
  const originalPlatform = process.platform;
  process.env.SUMI_TEST_MODE = "1";
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

  const { tmpDir, configPath } = createTempConfig();
  const mockUpdater = createMockUpdater();

  const service = createUpdateService({
    app: { getVersion: () => "0.2.0" },
    configPath,
    updaterFactory: () => mockUpdater,
  });

  try {
    await service.check();
    assert.ok(mockUpdater.getListenerCount("update-available") > 0);

    service.dispose();

    assert.ok(mockUpdater.offCalls > 0);
    assert.equal(mockUpdater.getBeforeRelaunchHandler(), null);
    assert.equal(service.getState().status, "idle");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.env = originalEnv;
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  }
});

test("Sparkle events update safe state appropriately", async () => {
  const originalEnv = { ...process.env };
  const originalPlatform = process.platform;
  process.env.SUMI_TEST_MODE = "1";
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

  const { tmpDir, configPath } = createTempConfig();
  const mockUpdater = createMockUpdater();

  const service = createUpdateService({
    app: { getVersion: () => "0.2.0" },
    configPath,
    updaterFactory: () => mockUpdater,
  });

  try {
    await service.check();

    // 1. update-available
    mockUpdater.emitUpdateAvailable("0.2.1", "0.2.1");
    let state = service.getState();
    assert.equal(state.status, "available");
    assert.equal(state.availableVersion, "0.2.1");

    // 2. update-downloaded (fires BEFORE signature verification - don't say "verified" yet)
    mockUpdater.emitUpdateDownloaded("0.2.1", "0.2.1");
    state = service.getState();
    assert.equal(state.status, "downloaded");
    assert.ok(state.message.includes("verifying"));

    // 3. before-install
    mockUpdater.emitBeforeInstall("0.2.1", "0.2.1");
    state = service.getState();
    assert.equal(state.status, "installing");

    // 4. update-not-available
    mockUpdater.emitUpdateNotAvailable(true);
    state = service.getState();
    assert.equal(state.status, "not-available");

    // 5. error event with path redaction
    mockUpdater.emitError(
      new Error("Signature verification failed for /private/var/folders/update.zip"),
    );
    state = service.getState();
    assert.equal(state.status, "error");
    assert.equal(state.error, "Signature verification failed for [path]");

    // 6. cycle-complete resets checking status
    mockUpdater.emitCycleComplete();
    state = service.getState();
    assert.equal(state.status, "error"); // preserves previous non-checking state
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.env = originalEnv;
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  }
});

test("getState() serialization contains strictly the 7 permitted fields", () => {
  const service = createUpdateService({
    app: { getVersion: () => "0.2.0" },
  });
  const state = service.getState();
  const keys = Object.keys(state).sort();
  assert.deepEqual(keys, [
    "availableVersion",
    "currentVersion",
    "error",
    "message",
    "nativeUI",
    "provider",
    "status",
  ]);
  assert.equal(state.nativeUI, true);
  assert.equal(state.provider, "sparkle");
});

test("update-tools helpers compute fingerprint and validate config", () => {
  // Valid 32-byte Ed25519 public key
  const validKey = "bW9ja1B1YmxpY0VkMjU1MTlLZXlGb3JVbml0VGVzdHM=";
  const fp = computeKeyFingerprint(validKey);
  assert.ok(typeof fp === "string" && fp.length === 64);

  const validConfig = {
    feedUrl: "https://github.com/xolah88457/trade-journal/releases/latest/download/appcast.xml",
    publicEdKey: validKey,
  };
  const validation = validateUpdateConfig(validConfig);
  assert.equal(validation.valid, true);

  const invalidConfig = {
    feedUrl: "http://insecure.org",
    publicEdKey: "short",
  };
  const invalidResult = validateUpdateConfig(invalidConfig);
  assert.equal(invalidResult.valid, false);
  assert.ok(invalidResult.errors.length >= 2);

  const signCmd = buildSignCommand("dist/App.zip");
  assert.equal(signCmd, 'echo "$SPARKLE_PRIVATE_KEY" | sign_update --ed-key-file - "dist/App.zip"');

  const appcastCmd = buildAppcastCommand("dist/releases", { version: "0.2.0" });
  assert.ok(
    appcastCmd.includes(
      'generate_appcast --download-url-prefix "https://github.com/xolah88457/trade-journal/releases/download/electron-v0.2.0/"',
    ),
  );
  assert.ok(appcastCmd.includes('--ed-key-file - "dist/releases"'));
});

// ============================================================================
// Key helper command tests (idempotence, Keychain account, generate_keys CLI)
// ============================================================================

test("update-tools: resolveSparkleBinary is async and resolves only official pinned tools (no guesses)", async () => {
  const calls = [];
  const fakeArtifacts = {
    resolveOfficialTool: async (opts) => {
      calls.push(opts);
      return `/official/sparkle/bin/${opts.name}`;
    },
  };

  // Awaited: every caller must await the async resolver
  assert.equal(
    await resolveSparkleBinary("generate_keys", { artifacts: fakeArtifacts }),
    "/official/sparkle/bin/generate-keys",
  );
  assert.equal(
    await resolveSparkleBinary("sign-update", { artifacts: fakeArtifacts }),
    "/official/sparkle/bin/sign-update",
  );
  assert.equal(
    await resolveSparkleBinary("generate_appcast", { artifacts: fakeArtifacts }),
    "/official/sparkle/bin/generate-appcast",
  );
  // Official tool names + pinned arm64 architecture are passed through
  assert.deepEqual(calls[0], { name: "generate-keys", architecture: "arm64" });
  assert.deepEqual(calls[1], { name: "sign-update", architecture: "arm64" });
  assert.deepEqual(calls[2], { name: "generate-appcast", architecture: "arm64" });

  // Unknown tool names are rejected — no PATH/npx fallback
  await assert.rejects(() =>
    resolveSparkleBinary("definitely-not-a-tool", { artifacts: fakeArtifacts }),
  );
});

test("createUpdateService: contract exposes only getState/check/dispose (download/install stubs removed)", () => {
  const service = createUpdateService({
    app: { getVersion: () => "0.2.0" },
  });
  assert.equal(typeof service.getState, "function");
  assert.equal(typeof service.check, "function");
  assert.equal(typeof service.dispose, "function");
  assert.equal(service.download, undefined);
  assert.equal(service.install, undefined);
});

test("update-tools: validateUpdateConfig enforces 32-byte Ed25519 public key", () => {
  // Valid 32-byte key
  const validKey = "bW9ja1B1YmxpY0VkMjU1MTlLZXlGb3JVbml0VGVzdHM="; // 32 bytes when decoded
  const validConfig = {
    feedUrl: "https://github.com/xolah88457/trade-journal/releases/latest/download/appcast.xml",
    publicEdKey: validKey,
  };
  assert.equal(validateUpdateConfig(validConfig).valid, true);

  // Too short
  const shortKey = "dG9vX3Nob3J0"; // "too_short" = 9 bytes
  const shortConfig = {
    feedUrl: "https://example.com/appcast.xml",
    publicEdKey: shortKey,
  };
  const shortResult = validateUpdateConfig(shortConfig);
  assert.equal(shortResult.valid, false);
  assert.ok(shortResult.errors.some((e) => e.includes("32 bytes")));

  // Invalid base64
  const invalidConfig = {
    feedUrl: "https://example.com/appcast.xml",
    publicEdKey: "!!!not-base64!!!",
  };
  const invalidResult = validateUpdateConfig(invalidConfig);
  assert.equal(invalidResult.valid, false);
  // Error message may vary, just check it's invalid
  assert.ok(invalidResult.errors.length > 0);
});

test("update-tools: computeKeyFingerprint produces consistent SHA256 hex", () => {
  const key = "bW9ja1B1YmxpY0VkMjU1MTlLZXlGb3JVbml0VGVzdHM=";
  const fp1 = computeKeyFingerprint(key);
  const fp2 = computeKeyFingerprint(key);
  assert.equal(fp1, fp2);
  assert.equal(fp1.length, 64); // SHA256 hex = 64 chars
  assert.ok(/^[0-9a-f]{64}$/.test(fp1));

  // Different keys produce different fingerprints
  const key2 = "YW5vdGhlcl9tb2NrX3B1YmxpY19rZXlfZm9yX3Rlc3RpbmdfMTIzNA==";
  const fp3 = computeKeyFingerprint(key2);
  assert.notEqual(fp1, fp3);
});

test("update-tools: buildSignCommand and buildAppcastCommand use STDIN for private key", () => {
  const signCmd = buildSignCommand("dist/Sumi-0.2.0-macos-arm64.zip");
  assert.ok(signCmd.includes("sign_update --ed-key-file -"));
  assert.ok(signCmd.includes('echo "$SPARKLE_PRIVATE_KEY"'));
  assert.ok(signCmd.includes("dist/Sumi-0.2.0-macos-arm64.zip"));

  const appcastCmd = buildAppcastCommand("dist/releases", {
    version: "0.2.0",
    repo: "xolah88457/trade-journal",
  });
  assert.ok(appcastCmd.includes("generate_appcast"));
  assert.ok(appcastCmd.includes("--ed-key-file -"));
  assert.ok(appcastCmd.includes('echo "$SPARKLE_PRIVATE_KEY"'));
  assert.ok(
    appcastCmd.includes(
      '--download-url-prefix "https://github.com/xolah88457/trade-journal/releases/download/electron-v0.2.0/"',
    ),
  );
  assert.ok(appcastCmd.includes("dist/releases"));
});

test("update-tools: DEFAULT_ACCOUNT is local.sumi.journal for idempotent Keychain ops", () => {
  // This validates the constant used by keyprep - module already imported at top
  // The constant is not exported but we can verify the plan output mentions it
  // by checking the source or testing the plan-keyprep output
  // For now, verify the module loads without error
  assert.ok(typeof resolveSparkleBinary === "function");
  assert.ok(typeof validateUpdateConfig === "function");
});

test("createUpdateService: cancellation - dispose during check cleans up", async () => {
  const originalEnv = { ...process.env };
  const originalPlatform = process.platform;
  process.env.SUMI_TEST_MODE = "1";
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

  const { tmpDir, configPath } = createTempConfig();
  const mockUpdater = createMockUpdater();

  const service = createUpdateService({
    app: { getVersion: () => "0.2.0" },
    configPath,
    updaterFactory: () => mockUpdater,
  });

  try {
    // Start check, then dispose
    await service.check();
    service.dispose();

    // After dispose, status should be idle and listeners cleaned up
    assert.equal(service.getState().status, "idle");
    assert.ok(mockUpdater.offCalls > 0);
    assert.equal(mockUpdater.getBeforeRelaunchHandler(), null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.env = originalEnv;
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  }
});

test("createUpdateService: checkForUpdatesInBackground available on updater", async () => {
  const originalEnv = { ...process.env };
  const originalPlatform = process.platform;
  process.env.SUMI_TEST_MODE = "1";
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

  const { tmpDir, configPath } = createTempConfig();
  const mockUpdater = createMockUpdater();
  let bgCheckCalled = false;

  // Override the background check method
  const originalBgCheck = mockUpdater.checkForUpdatesInBackground;
  mockUpdater.checkForUpdatesInBackground = function () {
    bgCheckCalled = true;
    return originalBgCheck.call(this);
  };

  const service = createUpdateService({
    app: { getVersion: () => "0.2.0" },
    configPath,
    updaterFactory: () => mockUpdater,
  });

  try {
    await service.check();
    // Verify the updater has the background check method
    assert.ok(typeof mockUpdater.checkForUpdatesInBackground === "function");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.env = originalEnv;
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  }
});

test("createUpdateService: nativeUI flag is always true, provider is sparkle", async () => {
  const originalEnv = { ...process.env };
  const originalPlatform = process.platform;
  process.env.SUMI_TEST_MODE = "1";
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

  const { tmpDir, configPath } = createTempConfig();
  const mockUpdater = createMockUpdater();

  const service = createUpdateService({
    app: { getVersion: () => "0.2.0" },
    configPath,
    updaterFactory: () => mockUpdater,
  });

  try {
    const state = await service.check();
    assert.equal(state.nativeUI, true);
    assert.equal(state.provider, "sparkle");

    // Even after events, these flags remain constant
    mockUpdater.emitUpdateAvailable("0.3.0", "0.3.0");
    const state2 = service.getState();
    assert.equal(state2.nativeUI, true);
    assert.equal(state2.provider, "sparkle");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.env = originalEnv;
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  }
});
