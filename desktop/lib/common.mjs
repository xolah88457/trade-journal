/**
 * Shared helpers for the desktop build, packaging, release and verification scripts.
 *
 * Build-time only: nothing here is copied into the application bundle (build.mjs
 * copies an explicit allowlist of desktop/*.cjs files plus generated metadata).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, posix, win32 } from "node:path";

/** Maps any Node arch string to the two architectures Sumi ships: "arm64" or "x64". */
export function normalizeArch(arch = process.arch) {
  return arch === "arm64" ? "arm64" : "x64";
}

/** Reads the root package.json version. Throws instead of guessing a stale fallback. */
export function readRootVersion(root) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (typeof pkg.version !== "string" || !pkg.version) {
    throw new Error(`Root package.json at ${root} has no version field.`);
  }
  return pkg.version;
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256File(filePath) {
  return sha256Hex(readFileSync(filePath));
}

/** Reads the first `length` bytes of a file (bounded; never scans large binaries). */
export function readFileHead(filePath, length) {
  const fd = openSync(filePath, "r");
  const head = Buffer.alloc(length);
  try {
    readSync(fd, head, 0, length, 0);
  } finally {
    closeSync(fd);
  }
  return head;
}

/** The only model file allowed inside the application bundle. */
export const ALLOWED_BUNDLED_MODEL = "silero-vad-v6.2-F32.gguf";

/**
 * Classifies a file or directory name that must never ship in a distribution.
 * Returns "env" | "database" | "model" | "secret", or null when the name is fine.
 */
export function forbiddenNameKind(name) {
  if (name.startsWith(".env")) return "env";
  if (/\.(db|sqlite)(-shm|-wal|-journal)?$/.test(name)) return "database";
  if (name.endsWith(".gguf") && name !== ALLOWED_BUNDLED_MODEL) return "model";
  if (name === ".secret") return "secret";
  return null;
}

export function isForbiddenName(name) {
  return forbiddenNameKind(name) !== null;
}

const FORBIDDEN_MESSAGES = {
  env: (name) => `Environment file bundled in distribution: ${name}`,
  database: (name) => `Database bundled in distribution: ${name}`,
  model: (name) =>
    `Forbidden model weights bundled in distribution: ${name}. Only Silero VAD is allowed in the application bundle.`,
  secret: (name) => `Secret file bundled in distribution: ${name}`,
};

/** Recursively throws if any private env/database/model/secret file exists under `directory`. */
export function checkNoPrivateFiles(directory) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const kind = forbiddenNameKind(entry.name);
    if (kind) throw new Error(FORBIDDEN_MESSAGES[kind](entry.name));
    if (entry.isDirectory()) checkNoPrivateFiles(join(directory, entry.name));
  }
}

/** Recursively removes private env/database/model/secret files from `directory`. */
export function cleanPrivateFiles(directory) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const p = join(directory, entry.name);
    if (isForbiddenName(entry.name)) {
      rmSync(p, { recursive: true, force: true });
    } else if (entry.isDirectory()) {
      cleanPrivateFiles(p);
    }
  }
}

/**
 * Determines whether targetPath is equal to or a canonical descendant of basePath.
 * Uses platform-specific path operations (win32 vs posix) so Windows path logic can be
 * fully verified on non-Windows hosts.
 *
 * Resolves real paths when the paths exist, folds case on Windows, uses a strict
 * relative-path boundary check (a child literally named "..foo" is still a child),
 * and rejects cross-drive or absolute relative results.
 */
export function isPathContained(baseDir, targetPath, platform = process.platform) {
  const isWin = platform === "win32";
  const pathApi = isWin ? win32 : posix;

  let target = targetPath;
  let base = baseDir;
  try {
    target = realpathSync(target);
  } catch {}
  try {
    base = realpathSync(base);
  } catch {}

  target = pathApi.resolve(target);
  base = pathApi.resolve(base);
  if (isWin) {
    target = target.toLowerCase();
    base = base.toLowerCase();
  }
  if (target === base) return true;

  const rel = pathApi.relative(base, target);
  if (rel === "") return true;
  // Cross-drive / UNC root escape ('D:\outside', '\\server2\share').
  if (pathApi.isAbsolute(rel)) return false;
  // Parent directory escape.
  if (rel === ".." || rel.startsWith(`..${pathApi.sep}`) || rel.startsWith("../")) return false;
  const basePrefix = base.endsWith(pathApi.sep) ? base : base + pathApi.sep;
  return target.startsWith(basePrefix);
}

/**
 * Recursively asserts that every symbolic link under `directory` resolves inside `base`.
 * Symlinks are not followed while walking; only their resolved targets are checked.
 *
 * @param {object} [options]
 * @param {string} [options.message] prefix of the error message ("<message>: <link> -> <real>")
 * @param {boolean} [options.skipMissing] return quietly when `directory` does not exist
 */
export function assertSymlinksConfined(directory, base, options = {}) {
  const { message = "Symlink escapes application bundle", skipMissing = true } = options;
  if (skipMissing && !existsSync(directory)) return;
  const canonicalBase = realpathSync(base);
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const real = realpathSync(p);
        if (!isPathContained(canonicalBase, real)) {
          throw new Error(`${message}: ${p} -> ${real}`);
        }
      } else if (entry.isDirectory()) {
        walk(p);
      }
    }
  };
  walk(directory);
}

/** Asserts that every symlink under `directory` resolves inside `basePrefix` (the app bundle). */
export function checkSelfContainedSymlinks(directory, basePrefix) {
  assertSymlinksConfined(directory, basePrefix);
}

/** Parses a "14.44.35111.0"-style version string into a 4-part numeric array (null if unparseable). */
export function parseFileVersionString(str) {
  if (typeof str !== "string") return null;
  const m = str.match(/(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] || 0)];
}

/**
 * Reads the PE FILEVERSION of a Windows DLL via PowerShell FileVersionInfo.
 * Returns a 4-part numeric array, or null when the output is unparseable.
 * Throws when PowerShell itself fails; `runTool` is injectable for tests.
 */
export function probeDllFileVersion(filePath, runTool = execFileSync) {
  const psPath = String(filePath).replace(/'/g, "''");
  const out = runTool(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$v = [System.Diagnostics.FileVersionInfo]::GetVersionInfo('${psPath}'); ` +
        `Write-Output "$($v.FileMajorPart).$($v.FileMinorPart).$($v.FileBuildPart).$($v.FilePrivatePart)"`,
    ],
    { encoding: "utf8" },
  );
  return { version: parseFileVersionString(String(out).trim().split(/\r?\n/)[0]), output: out };
}

/** Finds a DLL inside a directory case-insensitively; returns the full path or null. */
export function findFileCaseInsensitive(dir, name) {
  const direct = join(dir, name);
  if (existsSync(direct)) return direct;
  try {
    const match = readdirSync(dir).find((e) => e.toLowerCase() === name.toLowerCase());
    if (match) return join(dir, match);
  } catch {}
  return null;
}

/** Looks up the SHA-256 for `filename` in the text of an official SHASUMS256.txt. */
export function parseShaSums(sumsText, filename) {
  if (typeof sumsText !== "string" || !filename) return null;
  for (const line of sumsText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^([a-fA-F0-9]{64})\s+[*]?(.+)$/);
    if (match && match[2] === filename) {
      return match[1].toLowerCase();
    }
  }
  return null;
}

/**
 * Returns a cached archive when it still matches its expected SHA-256, otherwise downloads
 * the archive plus the official SHASUMS256.txt, verifies the archive against the official
 * (and, when given, the pinned) checksum, and caches both files.
 *
 * @param {object} spec
 * @param {string} spec.cacheDir
 * @param {string} spec.archiveName   file name inside the release (also the cache file name)
 * @param {string} spec.baseUrl       release directory URL holding the archive and SHASUMS256.txt
 * @param {string} spec.sumsCacheName cache file name for the downloaded SHASUMS256.txt
 * @param {string} spec.label         human name used in download errors ("official Node v22.1.0")
 * @param {string} spec.sumsLabel     human name of the sums file used in errors
 * @param {string} spec.archiveKind   "Electron" | "Node", used in the mismatch error
 * @param {number} spec.archiveTimeoutMs
 * @param {string} [spec.pinnedSha]   checksum compiled into this repo; must match the official one
 * @param {Function} [spec.fetchFn]   injectable fetch for tests
 */
export async function ensureVerifiedArchive(spec) {
  const {
    cacheDir,
    archiveName,
    baseUrl,
    sumsCacheName,
    label,
    sumsLabel,
    archiveKind,
    archiveTimeoutMs,
    pinnedSha = null,
    fetchFn = fetch,
  } = spec;
  mkdirSync(cacheDir, { recursive: true });
  const archivePath = join(cacheDir, archiveName);
  const sumsPath = join(cacheDir, sumsCacheName);

  // A pinned checksum is authoritative; the cached SHASUMS file is only trusted without one.
  let checksum = pinnedSha;
  if (!checksum && existsSync(sumsPath)) {
    checksum = parseShaSums(readFileSync(sumsPath, "utf8"), archiveName);
  }
  if (existsSync(archivePath) && checksum && sha256File(archivePath) === checksum) {
    return { archivePath, checksum };
  }

  const [archiveRes, sumsRes] = await Promise.all([
    fetchFn(`${baseUrl}/${archiveName}`, { signal: AbortSignal.timeout(archiveTimeoutMs) }),
    fetchFn(`${baseUrl}/SHASUMS256.txt`, { signal: AbortSignal.timeout(30_000) }),
  ]);
  if (!archiveRes.ok || !sumsRes.ok) {
    throw new Error(`Failed to download ${label} (${archiveRes.status}/${sumsRes.status}).`);
  }
  const sumsText = await sumsRes.text();
  checksum = parseShaSums(sumsText, archiveName);
  if (!checksum) {
    throw new Error(`Could not find checksum for ${archiveName} in ${sumsLabel}`);
  }
  if (pinnedSha && checksum !== pinnedSha) {
    throw new Error(
      `Official checksum for ${archiveName} (${checksum}) does not match pinned checksum (${pinnedSha})!`,
    );
  }
  const buffer = Buffer.from(await archiveRes.arrayBuffer());
  const actualHash = sha256Hex(buffer);
  if (actualHash !== checksum) {
    throw new Error(
      `${archiveKind} archive checksum mismatch: expected ${checksum}, got ${actualHash}`,
    );
  }
  writeFileSync(archivePath, buffer);
  writeFileSync(sumsPath, sumsText, "utf8");
  return { archivePath, checksum };
}
