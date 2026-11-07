import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  MAX_PREFERENCES_BYTES,
  realpathExisting,
  resolveDataDirectory,
  filterJournalPreferences,
  createPreferencesStore,
} from "./preferences.cjs";

test("resolveDataDirectory obeys test mode contract and isolated directory paths", () => {
  const originalEnv = { ...process.env };
  const defaultDir = path.join(os.homedir(), "Library", "Application Support", "Sumi");

  try {
    // Normal mode
    delete process.env.SUMI_TEST_MODE;
    delete process.env.JOURNAL_DATA_DIR;
    assert.equal(resolveDataDirectory(), defaultDir);

    // Test mode requires JOURNAL_DATA_DIR
    process.env.SUMI_TEST_MODE = "1";
    assert.throws(() => resolveDataDirectory(), /requires an absolute JOURNAL_DATA_DIR/);

    // Relative path rejected
    process.env.JOURNAL_DATA_DIR = "relative/path/dir";
    assert.throws(() => resolveDataDirectory(), /requires an absolute JOURNAL_DATA_DIR/);

    // Production Sumi path rejected in test mode
    process.env.JOURNAL_DATA_DIR = defaultDir;
    assert.throws(() => resolveDataDirectory(), /rejects the production Sumi data directory/);

    // Non-existing directory rejected
    const nonExistentDir = path.join(os.tmpdir(), "sumi-test-nonexistent");
    process.env.JOURNAL_DATA_DIR = nonExistentDir;
    assert.throws(() => resolveDataDirectory(), /must be an existing directory/);

    // Directory directly under os.tmpdir() (root) rejected
    const rootTmpDir = fs.realpathSync(os.tmpdir());
    process.env.JOURNAL_DATA_DIR = rootTmpDir;
    assert.throws(() => resolveDataDirectory(), /must be under os.tmpdir\(\) subdirectory/);

    // Directory outside os.tmpdir() rejected
    const outsideDir = path.join(os.homedir(), "sumi-test-outside");
    fs.mkdirSync(outsideDir, { recursive: true });
    process.env.JOURNAL_DATA_DIR = outsideDir;
    assert.throws(() => resolveDataDirectory(), /must be under os.tmpdir\(\) subdirectory/);
    fs.rmSync(outsideDir, { recursive: true, force: true });

    // Valid absolute path under os.tmpdir() subdirectory accepted
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-test-pref-dir-"));
    process.env.JOURNAL_DATA_DIR = testDir;
    // fs.realpathSync resolves symlinks (e.g., /var -> /private/var on macOS)
    assert.equal(resolveDataDirectory(), fs.realpathSync(testDir));
    fs.rmSync(testDir, { recursive: true, force: true });

    // Symlink alias rejected (must be canonical)
    const realDir = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-test-real-"));
    const symlinkDir = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-test-symlink-"));
    fs.rmSync(symlinkDir, { recursive: true, force: true });
    fs.symlinkSync(realDir, symlinkDir);
    process.env.JOURNAL_DATA_DIR = symlinkDir;
    // Should resolve to canonical realDir
    assert.equal(resolveDataDirectory(), fs.realpathSync(realDir));
    fs.rmSync(realDir, { recursive: true, force: true });
    fs.rmSync(symlinkDir, { recursive: true, force: true });
  } finally {
    // Restore IN PLACE: reassigning process.env would replace the live env object
    // and later mutations (e.g. HOME for os.homedir()) would stop propagating.
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
  }
});

test("realpathExisting canonicalizes symlinks without failing on missing paths", () => {
  // Existing dir with symlink alias (macOS /var -> /private/var style)
  const realDir = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-realpath-real-"));
  const aliasParent = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-realpath-alias-"));
  const alias = path.join(aliasParent, "link");
  fs.symlinkSync(realDir, alias);
  try {
    assert.equal(realpathExisting(alias), fs.realpathSync(realDir));
    // Missing path under an existing ancestor: resolves ancestor, re-appends remainder
    const missing = path.join(realDir, "does", "not", "exist");
    assert.equal(realpathExisting(missing), path.join(fs.realpathSync(realDir), "does/not/exist"));
  } finally {
    fs.rmSync(realDir, { recursive: true, force: true });
    fs.rmSync(aliasParent, { recursive: true, force: true });
  }
});

test("test mode does not fail when the production Sumi dir does not exist yet (first launch)", () => {
  const originalEnv = { ...process.env };
  // Point HOME at a fresh temp dir whose Library/Application Support/Sumi does NOT exist
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-fake-home-"));
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-test-firstlaunch-"));
  try {
    process.env.HOME = fakeHome;
    process.env.SUMI_TEST_MODE = "1";
    process.env.JOURNAL_DATA_DIR = testDir;
    // Must resolve without throwing even though ~/Library/Application Support/Sumi is missing
    assert.equal(resolveDataDirectory(), fs.realpathSync(testDir));

    // Once the prod dir exists, it and any descendant (incl. profile dir) are rejected
    const prodDir = path.join(fakeHome, "Library", "Application Support", "Sumi");
    fs.mkdirSync(path.join(prodDir, "electron"), { recursive: true }); // profile dir
    process.env.JOURNAL_DATA_DIR = prodDir;
    assert.throws(() => resolveDataDirectory(), /rejects the production Sumi data directory/);
    process.env.JOURNAL_DATA_DIR = path.join(prodDir, "electron");
    assert.throws(() => resolveDataDirectory(), /rejects the production Sumi data directory/);

    // Symlink alias of the prod dir is rejected (canonical realpath comparison)
    const alias = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-prod-alias-"));
    fs.rmSync(alias, { recursive: true, force: true });
    fs.symlinkSync(prodDir, alias);
    process.env.JOURNAL_DATA_DIR = alias;
    assert.throws(() => resolveDataDirectory(), /rejects the production Sumi data directory/);
    fs.rmSync(alias, { force: true });
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
    fs.rmSync(fakeHome, { recursive: true, force: true });
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

test("filterJournalPreferences preserves only journal-* string key-value pairs", () => {
  assert.deepEqual(filterJournalPreferences(null), {});
  assert.deepEqual(filterJournalPreferences([]), {});
  assert.deepEqual(filterJournalPreferences("string"), {});
  assert.deepEqual(filterJournalPreferences(42), {});

  const input = {
    "journal-theme-v1": "dark",
    "journal-sidebar": "collapsed",
    "not-journal": "secret",
    "journal-invalid-number": 123,
    "journal-invalid-bool": true,
    "journal-invalid-obj": { foo: "bar" },
    "": "empty",
  };

  const filtered = filterJournalPreferences(input);
  assert.deepEqual(filtered, {
    "journal-theme-v1": "dark",
    "journal-sidebar": "collapsed",
  });
});

test("preferences store enforces atomic write with 0o600 permissions", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-pref-atomic-"));
  try {
    const store = createPreferencesStore({ dataDir: tmpDir, isTestMode: true });
    const filePath = store.getFilePath();

    assert.ok(fs.existsSync(filePath));
    const stat = fs.statSync(filePath);
    // On POSIX, permissions should be 0o600
    if (process.platform !== "win32") {
      assert.equal(stat.mode & 0o777, 0o600);
    }

    const saved = store.savePreferences({
      "journal-theme-v1": "dark",
      "journal-font-size": "14",
    });
    assert.equal(saved, true);
    assert.deepEqual(store.getPreferences(), {
      "journal-theme-v1": "dark",
      "journal-font-size": "14",
    });

    const fileContent = JSON.parse(fs.readFileSync(filePath, "utf8"));
    assert.deepEqual(fileContent, {
      "journal-theme-v1": "dark",
      "journal-font-size": "14",
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("preferences store enforces 64KB aggregate limit", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-pref-limit-"));
  try {
    const store = createPreferencesStore({ dataDir: tmpDir, isTestMode: true });

    // Under 64KB is allowed
    const validLargeValue = "a".repeat(50_000);
    const success = store.savePreferences({ "journal-large": validLargeValue });
    assert.equal(success, true);
    assert.equal(store.getPreferences()["journal-large"], validLargeValue);

    // Over 64KB is rejected
    const oversizedValue = "b".repeat(70_000);
    const rejected = store.savePreferences({ "journal-oversized": oversizedValue });
    assert.equal(rejected, false);
    // Previous valid state preserved
    assert.equal(store.getPreferences()["journal-large"], validLargeValue);
    assert.equal(store.getPreferences()["journal-oversized"], undefined);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("corrupt preferences file surfaces warning, preserves raw file, and never silently overwrites", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-pref-corrupt-"));
  try {
    const filePath = path.join(tmpDir, "preferences.json");
    const corruptContent = "{ this is invalid json content that cannot be parsed }";
    fs.writeFileSync(filePath, corruptContent, { encoding: "utf8" });

    let warned = false;
    const origWarn = console.warn;
    console.warn = (...args) => {
      warned = true;
      origWarn(...args);
    };

    let store;
    try {
      store = createPreferencesStore({ dataDir: tmpDir, isTestMode: true });
    } finally {
      console.warn = origWarn;
    }

    assert.equal(warned, true);
    assert.equal(store.isCorrupted(), true);

    // Raw corrupt file must NOT have been overwritten with empty {}
    assert.equal(fs.readFileSync(filePath, "utf8"), corruptContent);
    // In-memory cache returns safe empty object
    assert.deepEqual(store.getPreferences(), {});

    // When saving new preferences, corrupt file must be preserved as backup
    const saved = store.savePreferences({ "journal-theme-v1": "dark" });
    assert.equal(saved, true);
    assert.equal(store.isCorrupted(), false);

    // Check that backup file was created
    const backupFiles = fs.readdirSync(tmpDir).filter((name) => name.includes(".corrupt-"));
    assert.equal(backupFiles.length, 1);
    assert.equal(fs.readFileSync(path.join(tmpDir, backupFiles[0]), "utf8"), corruptContent);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("skips UserDefaults migration entirely in test mode", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-pref-mig-test-"));
  try {
    let defaultsCalled = false;
    createPreferencesStore({
      dataDir: tmpDir,
      isTestMode: true,
      defaultsReader: () => {
        defaultsCalled = true;
        return JSON.stringify({ "journal-theme-v1": "dark" });
      },
    });

    assert.equal(defaultsCalled, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("migrates UserDefaults in normal mode on first launch if file does not exist", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-pref-mig-normal-"));
  try {
    let defaultsCalled = false;
    const store = createPreferencesStore({
      dataDir: tmpDir,
      isTestMode: false,
      defaultsReader: () => {
        defaultsCalled = true;
        return JSON.stringify({
          "journal-theme-v1": "dark",
          "unrelated-key": "ignore",
        });
      },
    });

    assert.equal(defaultsCalled, true);
    assert.deepEqual(store.getPreferences(), {
      "journal-theme-v1": "dark",
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
