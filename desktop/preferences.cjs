"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const MAX_PREFERENCES_BYTES = 65536; // 64KB aggregate limit

/**
 * Canonicalizes a path with fs.realpathSync (resolves symlinks, unlike path.resolve).
 * Never throws when the path does not exist yet: resolves the longest existing
 * ancestor (e.g. macOS /var -> /private/var) and re-appends the remainder, so a
 * missing production directory on normal first launch does not fail resolution.
 */
function realpathExisting(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    const parent = path.dirname(p);
    if (parent === p) return p;
    return path.join(realpathExisting(parent), path.basename(p));
  }
}

/**
 * Resolves the Sumi data directory.
 *
 * Normal contract:
 *   ~/Library/Application Support/Sumi EXACT.
 *
 * Test contract (SUMI_TEST_MODE=1):
 *   Requires JOURNAL_DATA_DIR to be an absolute path.
 *   MUST be an EXISTING directory under os.tmpdir() subdirectory (not root tmpdir).
 *   Strictly rejects the production Sumi data directory, the profile directory,
 *   or ANY descendant, and any symlink alias of them - canonical fs.realpathSync
 *   resolution BEFORE any writes.
 *   Handles macOS /var -> /private/var symlink.
 *   Override ONLY allowed when SUMI_TEST_MODE=1.
 */
function resolveDataDirectory() {
  const defaultDir = path.join(os.homedir(), "Library", "Application Support", "Sumi");
  const isTestMode = process.env.SUMI_TEST_MODE === "1";

  if (isTestMode) {
    const testDir = process.env.JOURNAL_DATA_DIR;
    if (!testDir || !path.isAbsolute(testDir)) {
      throw new Error("SUMI_TEST_MODE=1 requires an absolute JOURNAL_DATA_DIR");
    }

    // Canonicalize with fs.realpathSync (resolves symlinks, unlike path.resolve)
    // Must exist before any writes
    let canonicalTestDir;
    try {
      canonicalTestDir = fs.realpathSync(testDir);
    } catch {
      throw new Error("SUMI_TEST_MODE=1 JOURNAL_DATA_DIR must be an existing directory");
    }
    // Production dir may not exist yet on first launch - must NOT fail here
    const canonicalDefaultDir = realpathExisting(defaultDir);

    // Reject production Sumi directory, profile dir, or any descendant / symlink alias
    if (
      canonicalTestDir === canonicalDefaultDir ||
      canonicalTestDir.startsWith(canonicalDefaultDir + path.sep)
    ) {
      throw new Error("SUMI_TEST_MODE=1 rejects the production Sumi data directory");
    }

    // Must be under os.tmpdir() subdirectory (not root tmpdir)
    const tmpDir = realpathExisting(os.tmpdir());
    if (!canonicalTestDir.startsWith(tmpDir + path.sep) || canonicalTestDir === tmpDir) {
      throw new Error("SUMI_TEST_MODE=1 JOURNAL_DATA_DIR must be under os.tmpdir() subdirectory");
    }

    return canonicalTestDir;
  }

  return defaultDir;
}

/**
 * Filters a raw object to only keys beginning with "journal-" where values are strings.
 * Discards non-journal keys and non-string values.
 */
function filterJournalPreferences(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const filtered = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof key === "string" && key.startsWith("journal-") && typeof value === "string") {
      filtered[key] = value;
    }
  }
  return filtered;
}

/**
 * Atomically writes content to filePath with mode 0o600.
 */
function atomicWriteFileSync(filePath, content) {
  const dir = path.dirname(filePath);
  const tmpName = `${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  const tmpPath = path.join(dir, tmpName);

  fs.writeFileSync(tmpPath, content, { mode: 0o600, encoding: "utf8" });
  try {
    fs.chmodSync(tmpPath, 0o600);
  } catch {}
  fs.renameSync(tmpPath, filePath);
}

/**
 * Creates and initializes the preferences store.
 */
function createPreferencesStore(options = {}) {
  const isTestMode = options.isTestMode ?? process.env.SUMI_TEST_MODE === "1";
  const dataDir = options.dataDir || resolveDataDirectory();

  // Ensure dataDir exists with 0o700 permissions
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dataDir, 0o700);
  } catch {}

  const filePath = path.join(dataDir, "preferences.json");
  let cache = {};
  let corrupted = false;

  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      cache = filterJournalPreferences(parsed);
    } catch (err) {
      // Known error: surface warning and preserve raw corrupt file. Never silently overwrite.
      console.warn(
        `[preferences] Warning: corrupt preferences file at ${filePath}. Preserving raw file and not overwriting.`,
        err.message,
      );
      corrupted = true;
      cache = {};
    }
  } else {
    // One-time migration: only on normal first launch and if no preferences.json file exists.
    // In test mode: skips ALL UserDefaults imports.
    let migrated = false;
    if (!isTestMode) {
      try {
        const reader =
          options.defaultsReader ||
          (() =>
            execFileSync("defaults", ["read", "local.sumi.journal", "journalPreferences"], {
              encoding: "utf8",
            }));
        const rawDefaults = reader();
        if (typeof rawDefaults === "string" && rawDefaults.trim().length > 0) {
          const parsed = JSON.parse(rawDefaults);
          const filtered = filterJournalPreferences(parsed);
          const serialized = JSON.stringify(filtered);
          if (Buffer.byteLength(serialized, "utf8") <= MAX_PREFERENCES_BYTES) {
            atomicWriteFileSync(filePath, serialized);
            cache = filtered;
            migrated = true;
          }
        }
      } catch {
        // Defaults key not present or read failed; standard first launch without migration
      }
    }

    if (!migrated) {
      cache = {};
      atomicWriteFileSync(filePath, "{}");
    }
  }

  return {
    getPreferences() {
      // Fast cached in-memory access with no synchronous disk I/O on IPC turn
      return { ...cache };
    },

    savePreferences(dict) {
      const filtered = filterJournalPreferences(dict);
      const serialized = JSON.stringify(filtered);

      // Enforce 64KB aggregate limit
      if (Buffer.byteLength(serialized, "utf8") > MAX_PREFERENCES_BYTES) {
        console.warn("[preferences] Preferences exceed 64KB aggregate bound; save rejected.");
        return false;
      }

      // If existing file was corrupt, preserve a backup of the corrupt raw file before overwriting
      if (corrupted) {
        try {
          const backupPath = `${filePath}.corrupt-${Date.now()}`;
          if (fs.existsSync(filePath)) {
            fs.copyFileSync(filePath, backupPath);
            console.warn(`[preferences] Preserved corrupt preferences at ${backupPath}`);
          }
        } catch (backupErr) {
          console.error("[preferences] Failed to backup corrupt file:", backupErr);
        }
        corrupted = false;
      }

      try {
        atomicWriteFileSync(filePath, serialized);
        cache = filtered;
        return true;
      } catch (err) {
        console.error("[preferences] Failed to write preferences:", err);
        return false;
      }
    },

    getFilePath() {
      return filePath;
    },

    isCorrupted() {
      return corrupted;
    },
  };
}

module.exports = {
  MAX_PREFERENCES_BYTES,
  realpathExisting,
  resolveDataDirectory,
  filterJournalPreferences,
  atomicWriteFileSync,
  createPreferencesStore,
};
