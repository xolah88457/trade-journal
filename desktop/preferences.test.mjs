import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  MAX_PREFERENCES_BYTES,
  realpathExisting,
  isSameOrDescendant,
  isStrictDescendant,
  getDefaultDataDirectory,
  resolveDataDirectory,
  filterJournalPreferences,
  createPreferencesStore,
} from "./preferences.cjs";

test("resolveDataDirectory obeys test mode contract and isolated directory paths", () => {
  const originalEnv = { ...process.env };
  const defaultDir = getDefaultDataDirectory();

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
    const prodDir = getDefaultDataDirectory(process.platform, process.env, fakeHome);
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

test("getDefaultDataDirectory resolves canonical platform data paths for Windows, Linux, and macOS", () => {
  // macOS exact data path ~/Library/Application Support/Sumi
  const macDir = getDefaultDataDirectory("darwin", {}, "/Users/alice");
  assert.equal(macDir, "/Users/alice/Library/Application Support/Sumi");

  // Windows with APPDATA env
  const winDir = getDefaultDataDirectory(
    "win32",
    { APPDATA: "C:\\Users\\alice\\AppData\\Roaming" },
    "C:\\Users\\alice",
  );
  assert.equal(winDir, "C:\\Users\\alice\\AppData\\Roaming\\Sumi");

  // Windows without APPDATA env fallback
  const winFallback = getDefaultDataDirectory("win32", {}, "C:\\Users\\alice");
  assert.equal(winFallback, "C:\\Users\\alice\\AppData\\Roaming\\Sumi");

  // Linux with XDG_CONFIG_HOME
  const linuxXdg = getDefaultDataDirectory(
    "linux",
    { XDG_CONFIG_HOME: "/home/alice/.custom-config" },
    "/home/alice",
  );
  assert.equal(linuxXdg, "/home/alice/.custom-config/Sumi");

  // Linux default fallback ~/.config/Sumi
  const linuxDefault = getDefaultDataDirectory("linux", {}, "/home/alice");
  assert.equal(linuxDefault, "/home/alice/.config/Sumi");
});

test("UserDefaults migration is strictly macOS-only and never attempted on Windows or Linux", () => {
  const tmpDirWin = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-pref-win-"));
  const tmpDirLinux = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-pref-linux-"));

  try {
    let defaultsCalledWin = false;
    const storeWin = createPreferencesStore({
      dataDir: tmpDirWin,
      platform: "win32",
      isTestMode: false,
      defaultsReader: () => {
        defaultsCalledWin = true;
        return JSON.stringify({ "journal-theme-v1": "dark" });
      },
    });

    assert.equal(defaultsCalledWin, false, "UserDefaults must never be queried on Windows");
    assert.deepEqual(storeWin.getPreferences(), {});

    let defaultsCalledLinux = false;
    const storeLinux = createPreferencesStore({
      dataDir: tmpDirLinux,
      platform: "linux",
      isTestMode: false,
      defaultsReader: () => {
        defaultsCalledLinux = true;
        return JSON.stringify({ "journal-theme-v1": "dark" });
      },
    });

    assert.equal(defaultsCalledLinux, false, "UserDefaults must never be queried on Linux");
    assert.deepEqual(storeLinux.getPreferences(), {});
  } finally {
    fs.rmSync(tmpDirWin, { recursive: true, force: true });
    fs.rmSync(tmpDirLinux, { recursive: true, force: true });
  }
});

test("mocked rename-fail preserves original preferences untouched and cleans up temporary file", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-pref-fail-"));
  const initialData = { "journal-theme-v1": "original-dark" };

  try {
    const store = createPreferencesStore({ dataDir: tmpDir, isTestMode: true });
    const saved = store.savePreferences(initialData);
    assert.equal(saved, true);
    assert.deepEqual(store.getPreferences(), initialData);

    const filePath = store.getFilePath();
    const originalContent = fs.readFileSync(filePath, "utf8");

    // Mock fs.renameSync to simulate EBUSY / EPERM / EACCES lock failure
    const origRenameSync = fs.renameSync;
    let renameAttempts = 0;
    fs.renameSync = () => {
      renameAttempts++;
      const err = new Error("Resource locked by antivirus or indexing");
      err.code = "EBUSY";
      throw err;
    };

    try {
      // Attempting to overwrite existing preferences with new data
      const saveResult = store.savePreferences({ "journal-theme-v1": "new-light" });
      assert.equal(saveResult, false, "savePreferences must return false on write failure");

      // Verify original file is completely untouched
      assert.equal(
        fs.readFileSync(filePath, "utf8"),
        originalContent,
        "Original preferences file must remain intact and untouched",
      );

      // Verify in-memory cache preserved original state
      assert.deepEqual(store.getPreferences(), initialData);

      // Verify no temporary .tmp files left behind
      const files = fs.readdirSync(tmpDir);
      const tmpFiles = files.filter((f) => f.includes(".tmp"));
      assert.equal(tmpFiles.length, 0, "Temporary write file must be cleaned up");
    } finally {
      fs.renameSync = origRenameSync;
    }

    assert.equal(
      renameAttempts,
      1,
      "renameSync must have been attempted exactly once without destructive fallback",
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("isSameOrDescendant and isStrictDescendant handle Windows case-folding, normalized slashes, and sibling prefix isolation", () => {
  // Case-folding equality on Windows
  assert.equal(
    isSameOrDescendant(
      "C:\\Users\\Alice\\AppData\\Roaming\\Sumi",
      "c:\\users\\alice\\appdata\\roaming\\sumi",
      "win32",
    ),
    true,
  );
  assert.equal(
    isStrictDescendant(
      "C:\\Users\\Alice\\AppData\\Roaming\\Sumi",
      "c:\\users\\alice\\appdata\\roaming\\sumi",
      "win32",
    ),
    false,
  );

  // Subdirectory containment with case and slash differences
  assert.equal(
    isSameOrDescendant(
      "C:/Users/Alice/AppData/Roaming/Sumi/electron/profile",
      "c:\\users\\alice\\appdata\\roaming\\sumi",
      "win32",
    ),
    true,
  );
  assert.equal(
    isStrictDescendant(
      "C:/Users/Alice/AppData/Roaming/Sumi/electron/profile",
      "c:\\users\\alice\\appdata\\roaming\\sumi",
      "win32",
    ),
    true,
  );

  // Sibling directory with shared prefix must NOT be considered a descendant
  assert.equal(
    isSameOrDescendant(
      "C:\\Users\\Alice\\AppData\\Roaming\\Sumi-backup",
      "c:\\users\\alice\\appdata\\roaming\\sumi",
      "win32",
    ),
    false,
  );
  assert.equal(
    isStrictDescendant(
      "C:\\Users\\Alice\\AppData\\Roaming\\Sumi-backup",
      "c:\\users\\alice\\appdata\\roaming\\sumi",
      "win32",
    ),
    false,
  );

  // Root tmpdir is not a strict descendant of itself
  assert.equal(isStrictDescendant("C:\\Temp", "c:\\temp", "win32"), false);
  assert.equal(isStrictDescendant("C:\\Temp\\sub", "c:\\temp", "win32"), true);
});

test("getDefaultDataDirectory ignores relative APPDATA and relative XDG_CONFIG_HOME", () => {
  // Windows relative APPDATA must be ignored (falls back to <homedir>\AppData\Roaming\Sumi)
  const winRel = getDefaultDataDirectory(
    "win32",
    { APPDATA: "relative\\path" },
    "C:\\Users\\Alice",
  );
  assert.equal(winRel, "C:\\Users\\Alice\\AppData\\Roaming\\Sumi");

  // Windows absolute APPDATA is accepted
  const winAbs = getDefaultDataDirectory(
    "win32",
    { APPDATA: "D:\\Custom\\AppData" },
    "C:\\Users\\Alice",
  );
  assert.equal(winAbs, "D:\\Custom\\AppData\\Sumi");

  // Linux relative XDG_CONFIG_HOME must be ignored (falls back to <homedir>/.config/Sumi)
  const linuxRel = getDefaultDataDirectory(
    "linux",
    { XDG_CONFIG_HOME: "relative/path" },
    "/home/alice",
  );
  assert.equal(linuxRel, "/home/alice/.config/Sumi");

  // Linux absolute XDG_CONFIG_HOME is accepted
  const linuxAbs = getDefaultDataDirectory(
    "linux",
    { XDG_CONFIG_HOME: "/opt/custom/config" },
    "/home/alice",
  );
  assert.equal(linuxAbs, "/opt/custom/config/Sumi");
});

test("corrupt preferences save aborts if backup copy fails and leaves raw file and corrupted state intact", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-pref-backup-fail-"));
  const corruptContent = "{ unparseable corrupt raw json content }";
  const filePath = path.join(tmpDir, "preferences.json");
  fs.writeFileSync(filePath, corruptContent, "utf8");

  try {
    const store = createPreferencesStore({ dataDir: tmpDir, isTestMode: true });
    assert.equal(store.isCorrupted(), true, "Store must detect corrupt file on init");

    // Mock fs.copyFileSync to simulate backup copy failure (e.g. disk full or EACCES)
    const origCopy = fs.copyFileSync;
    fs.copyFileSync = () => {
      const err = new Error("Failed to copy file to backup");
      err.code = "EACCES";
      throw err;
    };

    try {
      const saveResult = store.savePreferences({ "journal-theme-v1": "dark" });
      assert.equal(
        saveResult,
        false,
        "savePreferences must abort and return false if backup copy fails",
      );

      // Corrupted flag must REMAIN true so next save will also attempt to preserve backup
      assert.equal(
        store.isCorrupted(),
        true,
        "Store must remain in corrupted state when backup fails",
      );

      // Original raw corrupt file must remain intact and NOT overwritten
      assert.equal(
        fs.readFileSync(filePath, "utf8"),
        corruptContent,
        "Raw corrupt file must be preserved intact",
      );
    } finally {
      fs.copyFileSync = origCopy;
    }

    // Now verify that when backup copy succeeds, save proceeds and clears corrupted flag
    const secondSaveResult = store.savePreferences({ "journal-theme-v1": "dark" });
    assert.equal(secondSaveResult, true, "savePreferences succeeds once backup succeeds");
    assert.equal(store.isCorrupted(), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
