#!/usr/bin/env node
/**
 * desktop/update-tools.mjs
 *
 * Sparkle Ed25519 update release tooling for Sumi Electron.
 *
 * Responsibilities:
 * - Idempotent key preparation (generate or reuse existing Keychain key, account ALWAYS "local.sumi.journal")
 * - Safe export to GitHub Secret (SPARKLE_PRIVATE_KEY) via STDIN with NO secret in argv/stdout/stderr
 * - Secure temporary 0600 file lifecycle in a 0700 temp dir, zero-filled in finally blocks
 *   (best-effort overwrite; this is not an APFS physical-shred guarantee)
 * - Public-only output + fingerprint logging
 * - Exact sign_update and generate_appcast CLI invocations matching Sparkle 2.9.6:
 *     generate_keys --account <account> [-p] [-x FILE]
 *     sign_update --ed-key-file - <archive>            (private key via STDIN, base64)
 *     generate_appcast --download-url-prefix <url> --ed-key-file - <dir>
 *   The tools do NOT auto-read any SPARKLE_PRIVATE_KEY environment variable; the key is
 *   always piped explicitly via STDIN.
 *
 * Tool resolution: pinned electron-sparkle@0.2.0 only. The package root is resolved through
 * the allowed "./package.json" export via createRequire(import.meta.url), the installed
 * version is verified against the pin, and the official (checksum-verified) Sparkle tools
 * are obtained from dist/artifacts-C_Z5iSIA.cjs -> resolveOfficialTool({ name, architecture }).
 * There are deliberately NO PATH lookups, NO npx shims, and NO unversioned guesses.
 */

import { spawn } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "update-config.json");
const DEFAULT_REPO = "xolah88457/trade-journal";
const DEFAULT_ACCOUNT = "local.sumi.journal"; // dedicated Keychain identity, ALWAYS used; idempotent, no rotation

const SPARKLE_PACKAGE = "electron-sparkle";
const SPARKLE_PINNED_VERSION = "0.2.0"; // must match root package.json devDependencies pin
const SPARKLE_ARCHITECTURE = "arm64";
const SPARKLE_ARTIFACTS_CJS = "artifacts-C_Z5iSIA.cjs"; // shipped inside electron-sparkle 0.2.0 dist/

// Official Sparkle tool names accepted by resolveOfficialTool (OFFICIAL_TOOL_FILENAMES).
const OFFICIAL_TOOL_NAMES = {
  "generate-keys": "generate-keys",
  generate_keys: "generate-keys",
  "sign-update": "sign-update",
  sign_update: "sign-update",
  "generate-appcast": "generate-appcast",
  generate_appcast: "generate-appcast",
};

// DER prefix of a PKCS#8 Ed25519 private key wrapping a raw 32-byte seed:
// SEQUENCE { INTEGER 0, SEQUENCE { OID 1.3.101.112 }, OCTET STRING { OCTET STRING(32) } }
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

const requireFromHere = createRequire(import.meta.url);

/**
 * Computes a public key fingerprint (SHA256 hex) for logging and verification.
 * Safe to print publicly.
 */
export function computeKeyFingerprint(base64PublicKey) {
  if (!base64PublicKey || typeof base64PublicKey !== "string") {
    return null;
  }
  const clean = base64PublicKey.trim();
  const buffer = Buffer.from(clean, "base64");
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Validates the update configuration object.
 * Canonical fields: feedUrl, publicEdKey, releaseTagPrefix, archiveUrlPattern.
 */
export function validateUpdateConfig(config) {
  const errors = [];
  if (!config || typeof config !== "object") {
    return { valid: false, errors: ["Config must be an object"] };
  }
  if (!config.feedUrl || !config.feedUrl.startsWith("https://")) {
    errors.push("feedUrl must be an HTTPS URL");
  }
  if (
    !config.publicEdKey ||
    typeof config.publicEdKey !== "string" ||
    config.publicEdKey.trim().length === 0
  ) {
    errors.push("publicEdKey is missing or empty");
  } else {
    try {
      const decoded = Buffer.from(config.publicEdKey.trim(), "base64");
      if (decoded.length !== 32) {
        errors.push(`publicEdKey must decode to 32 bytes (got ${decoded.length})`);
      }
    } catch {
      errors.push("publicEdKey is not valid base64");
    }
  }
  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Loads the artifacts module of the PINNED electron-sparkle package.
 *
 * Resolution strategy (no guesses):
 * 1. createRequire(import.meta.url).resolve("electron-sparkle/package.json") — the only
 *    package subpath allowed by electron-sparkle's exports map.
 * 2. Verify the installed version is exactly the pinned 0.2.0 (and cross-check the
 *    monorepo root package.json pin when declared).
 * 3. require() the absolute <packageRoot>/dist/artifacts-C_Z5iSIA.cjs and check that it
 *    exports resolveOfficialTool.
 */
export function loadSparkleArtifactsModule(options = {}) {
  const packageJsonPath =
    options.packageJsonPath || requireFromHere.resolve(`${SPARKLE_PACKAGE}/package.json`);

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  } catch {
    throw new Error("Sanitized error: Could not read electron-sparkle package.json.");
  }
  if (pkg.name !== SPARKLE_PACKAGE || pkg.version !== SPARKLE_PINNED_VERSION) {
    throw new Error(
      `Sanitized error: electron-sparkle must be pinned to exactly ${SPARKLE_PINNED_VERSION} (found ${pkg.version || "unknown"}). Refusing to resolve Sparkle tools.`,
    );
  }

  // Cross-check the monorepo-level pin when the root package.json declares it.
  try {
    const rootPkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    const declared = rootPkg.devDependencies && rootPkg.devDependencies[SPARKLE_PACKAGE];
    if (declared && declared !== SPARKLE_PINNED_VERSION) {
      throw new Error(
        `Sanitized error: root package.json pins electron-sparkle to ${declared}, expected ${SPARKLE_PINNED_VERSION}.`,
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Sanitized error:")) throw err;
    // Root package.json not readable (e.g. packaged app) — installed-version pin still enforced above.
  }

  const packageRoot = path.dirname(packageJsonPath);
  const artifactsPath = path.join(packageRoot, "dist", SPARKLE_ARTIFACTS_CJS);
  if (!fs.existsSync(artifactsPath)) {
    throw new Error(
      `Sanitized error: electron-sparkle ${SPARKLE_PINNED_VERSION} artifacts module (dist/${SPARKLE_ARTIFACTS_CJS}) not found.`,
    );
  }
  const artifacts = requireFromHere(artifactsPath);
  if (!artifacts || typeof artifacts.resolveOfficialTool !== "function") {
    throw new Error(
      "Sanitized error: electron-sparkle artifacts module does not export resolveOfficialTool.",
    );
  }
  return artifacts;
}

/**
 * Resolves the absolute path of an official Sparkle CLI tool.
 *
 * ASYNC — every caller MUST await this. The tool comes from the pinned electron-sparkle
 * 0.2.0 package via resolveOfficialTool({ name, architecture: "arm64" }), which
 * materializes the checksum-verified Sparkle 2.9.6 distribution. NO PATH/npx/guessed
 * fallback is ever returned.
 *
 * @param {string} toolName "generate-keys" | "sign-update" | "generate-appcast" (or *_ form)
 * @param {object} [options] { artifacts?, packageJsonPath?, architecture? } (injection for tests)
 * @returns {Promise<string>} absolute path to the official tool binary
 */
export async function resolveSparkleBinary(toolName, options = {}) {
  const name = OFFICIAL_TOOL_NAMES[toolName];
  if (!name) {
    throw new Error(
      `Sanitized error: Unknown Sparkle tool '${toolName}'. Expected generate-keys, sign-update, or generate-appcast.`,
    );
  }
  const artifacts = options.artifacts || loadSparkleArtifactsModule(options);
  const architecture = options.architecture || SPARKLE_ARCHITECTURE;
  return await artifacts.resolveOfficialTool({ name, architecture });
}

/**
 * Runs a Sparkle CLI tool, capturing stdout/stderr. The captured output may contain
 * sensitive material — callers must NEVER print it.
 *
 * @returns {Promise<{code:number, signal:string|null, stdout:string, stderr:string}>}
 */
export function runSparkleTool(binPath, args, options = {}) {
  const spawnFn = options.spawnImpl || spawn;
  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawnFn(binPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      // Synchronous spawn failure — reject sanitized, never leak the raw error
      rejectPromise(new Error("Sanitized error: Failed to execute Sparkle tool."));
      return;
    }
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      // Constant message — never includes argv, input, stdout/stderr, or paths
      rejectPromise(new Error("Sanitized error: Failed to execute Sparkle tool."));
    };
    const stdoutChunks = [];
    const stderrChunks = [];
    if (child.stdout) child.stdout.on("data", (c) => stdoutChunks.push(c));
    if (child.stderr) child.stderr.on("data", (c) => stderrChunks.push(c));
    child.once("error", fail);
    child.once("close", (code, signal) => {
      if (settled) return; // a late close after a reject is a safe no-op
      settled = true;
      resolvePromise({
        code: code == null ? -1 : code,
        signal: signal || null,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
    if (child.stdin) {
      // Attach the stdin error handler BEFORE any write/end: if the child exits early,
      // the stdin stream emits EPIPE; without a listener this crashes the process with an
      // unhandled 'error' event and would skip executeKeyprep's finally cleanup.
      child.stdin.once("error", fail);
      if (options.input != null) {
        child.stdin.write(options.input);
      }
      child.stdin.end();
    }
  });
}

/**
 * Throws a fixed sanitized message when a tool run failed. The message NEVER contains
 * the tool's stdout/stderr (which may hold key material or local paths).
 */
export function assertToolSuccess(result, sanitizedMessage) {
  if (!result || result.code !== 0) {
    throw new Error(sanitizedMessage);
  }
  return result;
}

/**
 * Classifies the result of `generate_keys --account <account> -p` (public key lookup):
 *  - "present": a key exists; returns its base64 public key
 *  - "denied":  Keychain access denied / authorization canceled / item corrupt — must halt,
 *               NEVER fall through to key generation (that would rotate the identity)
 *  - "missing": no key exists yet — safe to generate
 * Classification uses fixed patterns from Sparkle 2.9.6's generate_keys diagnostics; the
 * raw stderr is never surfaced to logs.
 */
export function classifyKeychainLookup(result) {
  if (!result) return { status: "missing" };
  const stdout = (result.stdout || "").trim();
  const stderr = (result.stderr || "").toLowerCase();
  if (result.code === 0 && stdout && !/error|not found/i.test(stdout)) {
    return { status: "present", publicKey: stdout };
  }
  if (
    /access denied|denied access|blocked access|user canceled|user cancelled|corrupt|conflicting key/.test(
      stderr,
    )
  ) {
    return { status: "denied" };
  }
  return { status: "missing" };
}

/**
 * Derives the raw 32-byte Ed25519 public key from a 32-byte seed by wrapping it in a
 * PKCS#8 DER structure and exporting the SPKI form; the public key is the last 32 bytes
 * of the SPKI. Note: the public key is NOT the seed prefix.
 */
export function derivePublicKeyFromSeed(seed) {
  if (!Buffer.isBuffer(seed) || seed.length !== 32) {
    throw new Error("Sanitized error: Ed25519 seed must be exactly 32 bytes.");
  }
  const pkcs8 = Buffer.concat([PKCS8_ED25519_PREFIX, seed]);
  const privateKey = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  return spki.subarray(-32);
}

/**
 * Verifies that an exported private key (the file written by `generate_keys -x`) matches
 * the configured base64 public key.
 *
 * Actual official export format (verified against Sparkle 2.9.6 generate_keys): the file
 * contains BASE64 TEXT which decodes to either 32 bytes (new format: raw seed) or 96 bytes
 * (legacy format: 64-byte private key || 32-byte public key). A 64-byte seed||public
 * blob is also accepted defensively. Raw 32/64-byte binary files are NOT the official
 * format and are rejected.
 *
 * @param {Buffer} exportedKeyData raw bytes of the -x export file
 * @param {string} publicKeyBase64 configured SUPublicEDKey (base64 of 32 bytes)
 * @returns {boolean}
 */
export function verifyPrivateKeyMatchesPublic(exportedKeyData, publicKeyBase64) {
  if (!Buffer.isBuffer(exportedKeyData) || exportedKeyData.length === 0) return false;
  const text = exportedKeyData.toString("utf8").trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return false; // official export is base64 text
  let decoded;
  try {
    decoded = Buffer.from(text, "base64");
  } catch {
    return false;
  }
  let seed = null;
  let embeddedPublic = null;
  if (decoded.length === 32) {
    seed = decoded; // new format: 32-byte seed
  } else if (decoded.length === 64) {
    seed = decoded.subarray(0, 32);
    embeddedPublic = decoded.subarray(32); // seed || public
  } else if (decoded.length === 96) {
    seed = decoded.subarray(0, 32); // legacy: 64-byte private key (seed||public) || 32-byte public
    embeddedPublic = decoded.subarray(64, 96);
  } else {
    return false;
  }
  let derived;
  try {
    derived = derivePublicKeyFromSeed(seed);
  } catch {
    return false;
  }
  if (embeddedPublic && !derived.equals(embeddedPublic)) return false;
  let expected;
  try {
    expected = Buffer.from(String(publicKeyBase64 || "").trim(), "base64");
  } catch {
    return false;
  }
  return expected.length === 32 && derived.equals(expected);
}

/**
 * Uploads the private key to the repo's SPARKLE_PRIVATE_KEY GitHub secret via STDIN.
 * Fixed argv — the secret is NEVER a command-line argument and is never logged.
 */
export function setRepoSecretViaStdin(options = {}) {
  const repo = options.repo;
  const secret = options.secret;
  const spawnFn = options.spawnImpl || spawn;
  if (!repo || !Buffer.isBuffer(secret) || secret.length === 0) {
    return Promise.reject(
      new Error("Sanitized error: Missing repo or secret for GitHub secret upload."),
    );
  }
  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawnFn("gh", ["secret", "set", "SPARKLE_PRIVATE_KEY", "--repo", repo], {
        stdio: ["pipe", "ignore", "ignore"],
      });
    } catch {
      rejectPromise(
        new Error("Sanitized error: Failed to execute gh CLI. Ensure GitHub CLI is installed."),
      );
      return;
    }
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      // Constant sanitized message — never includes the secret or raw child errors
      rejectPromise(new Error("Sanitized error: Failed to pipe secret to gh CLI via STDIN."));
    };
    child.once("error", fail);
    child.once("close", (code) => {
      if (settled) return; // a late close after a reject is a safe no-op
      settled = true;
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error("Sanitized error: gh secret set failed."));
      }
    });
    if (child.stdin) {
      // Attach the stdin error handler BEFORE write/end: if gh is missing or exits early,
      // the stdin stream emits EPIPE; without a listener the process crashes (unhandled
      // 'error') and executeKeyprep's finally would NOT run — the exported private key
      // file would be left on disk.
      child.stdin.once("error", fail);
      child.stdin.write(secret);
      child.stdin.end();
    } else {
      fail();
    }
  });
}

/**
 * Returns exact sign command documentation.
 * Actual CLI (space-separated): sign_update --ed-key-file - <archive>  with the base64
 * private key piped on STDIN.
 */
export function buildSignCommand(archivePath) {
  return `echo "$SPARKLE_PRIVATE_KEY" | sign_update --ed-key-file - "${archivePath}"`;
}

/**
 * Returns exact generate_appcast command documentation.
 */
export function buildAppcastCommand(releasesDir, options = {}) {
  const version = options.version || "<version>";
  const prefix =
    options.downloadUrlPrefix ||
    `https://github.com/${options.repo || DEFAULT_REPO}/releases/download/electron-v${version}/`;
  return `echo "$SPARKLE_PRIVATE_KEY" | generate_appcast --download-url-prefix "${prefix}" --ed-key-file - "${releasesDir}"`;
}

/**
 * Builds the release plan from the VALIDATED update config — the feed URL and the fixed
 * archive URL always come from desktop/update-config.json (feedUrl / archiveUrlPattern),
 * never from an undeclared default.
 */
export function buildReleasePlan(options = {}) {
  const config = options.config;
  const validation = validateUpdateConfig(config);
  if (!validation.valid) {
    throw new Error(
      "Sanitized error: update-config.json is invalid: " + validation.errors.join("; "),
    );
  }
  const version = String(options.version || "");
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("Sanitized error: version must be semver-like (X.Y.Z).");
  }
  const pattern = config.archiveUrlPattern;
  if (
    typeof pattern !== "string" ||
    !pattern.startsWith("https://") ||
    !pattern.includes("{version}")
  ) {
    throw new Error(
      "Sanitized error: archiveUrlPattern must be an HTTPS URL containing {version}.",
    );
  }
  const archiveURL = pattern.split("{version}").join(version); // fixed archive URL from config
  const slash = archiveURL.lastIndexOf("/");
  const zipName = decodeURIComponent(archiveURL.slice(slash + 1));
  if (!zipName.toLowerCase().endsWith(".zip")) {
    throw new Error(
      "Sanitized error: archiveUrlPattern must reference the ZIP archive (ZIP-only update feed).",
    );
  }
  const downloadUrlPrefix = archiveURL.slice(0, slash + 1);

  let feedUrl = config.feedUrl; // validated config feedUrl — no undeclared default
  if (options.feedUrlOverride) {
    if (!String(options.feedUrlOverride).startsWith("https://")) {
      throw new Error("Sanitized error: --feed-url override must be an HTTPS URL.");
    }
    feedUrl = options.feedUrlOverride;
  }

  const distDir = options.distDir || "dist";
  return {
    version,
    feedUrl,
    publicEdKey: config.publicEdKey,
    archiveURL,
    zipName,
    downloadUrlPrefix,
    zipPath: path.join(distDir, zipName),
    appcastPath: path.join(distDir, "appcast.xml"),
    distDir,
    repo: options.repo || DEFAULT_REPO,
    releaseTagPrefix:
      typeof config.releaseTagPrefix === "string" && config.releaseTagPrefix
        ? config.releaseTagPrefix
        : "electron-v",
  };
}

/**
 * Prints the plan and exact commands for operator / coordinator review.
 */
export function printKeyprepPlan(options = {}) {
  const repo = options.repo || DEFAULT_REPO;
  const account = DEFAULT_ACCOUNT;

  console.log(`
================================================================================
SPARKLE Ed25519 KEY PREPARATION & SECURITY REVIEW PLAN
================================================================================

Target Repository: ${repo}
Keychain Account:  ${account}  (dedicated identity — ALWAYS this account, no rotation)
Public Config:     ${CONFIG_PATH}
Toolchain:         pinned electron-sparkle ${SPARKLE_PINNED_VERSION}, official Sparkle 2.9.6
                   tools resolved via resolveOfficialTool({ name, architecture: "${SPARKLE_ARCHITECTURE}" })

SECURITY CONSTRAINTS ENFORCED:
1. Private key is NEVER passed in command-line arguments.
2. Private key is piped directly into 'gh secret set' via STDIN (fixed argv, fixed repo).
3. Private key is NEVER output to stdout, stderr, or repository files.
4. If an error occurs, error stdout/stderr are captured internally but NEVER printed.
5. Temporary export file uses mode 0600 in a 0700 dir outside the repo, zero-filled and
   unlinked in a finally block (best-effort; not a physical-shred guarantee).
6. Idempotency: an existing Keychain key is preserved; a mismatch with the config halts.
   Keychain access-denied / user-canceled is distinguished from "no key" and halts.
7. The exported private key is verified against the public key (PKCS#8/SPKI derivation)
   BEFORE anything is uploaded.
8. The PUBLIC config (publicEdKey) is persisted BEFORE the secret upload, so a failed
   upload can be retried without rotating the identity.
9. Only the Ed25519 public key and its fingerprint are logged to stdout.

WORKFLOW COMMANDS (Automated by --execute, or runnable manually):
1. Check existing key:
   generate_keys --account "${account}" -p

2. Generate key in Keychain (only if none exists):
   generate_keys --account "${account}"

3. Export private key to secure temporary file (mode 0600 outside repo):
   generate_keys --account "${account}" -x /tmp/sparkle-key-XXXXXX/seed.key

4. Pipe private key into GitHub Secrets via STDIN:
   gh secret set SPARKLE_PRIVATE_KEY --repo "${repo}" < /tmp/sparkle-key-XXXXXX/seed.key

5. Zero-fill temp file and delete:
   wipe / unlink /tmp/sparkle-key-XXXXXX/seed.key

6. Write public key to desktop/update-config.json (persisted BEFORE step 4 in --execute).

To execute this plan after coordinator review, run:
  node desktop/update-tools.mjs keyprep --execute
================================================================================
`);
}

/**
 * Executes idempotent key preparation with maximum security protections.
 *
 * Dependencies are injectable for unit tests (synthetic in-memory fixtures only — no real
 * Keychain access in tests): resolveTool(name), runTool(bin, args), setSecret({repo, secret}).
 */
export async function executeKeyprep(options = {}) {
  const repo = options.repo || DEFAULT_REPO;
  const account = DEFAULT_ACCOUNT; // ALWAYS the dedicated identity; no rotation
  const configPath = options.configPath || CONFIG_PATH;
  const resolveTool =
    options.resolveTool ||
    ((name) => resolveSparkleBinary(name, { architecture: SPARKLE_ARCHITECTURE }));
  const runTool = options.runTool || runSparkleTool;
  const setSecret = options.setSecret || ((o) => setRepoSecretViaStdin(o));

  console.log(`[keyprep] Starting Sparkle Ed25519 key preparation for repo: ${repo}`);

  // 1. Read existing update-config.json
  let config = {};
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch {
      throw new Error("Sanitized error: Failed to parse update-config.json");
    }
  }
  const configuredPublicKey = (config.publicEdKey || "").trim();

  // 2. Query Keychain for existing public key: generate_keys --account <account> -p
  const genBin = await resolveTool("generate-keys");
  const lookup = await runTool(genBin, ["-p", "--account", account]);
  const lookupClass = classifyKeychainLookup(lookup);
  if (lookupClass.status === "denied") {
    // Access denied / canceled / corrupt — halt; NEVER generate (that would rotate identity)
    throw new Error(
      "Sanitized error: Keychain access was denied or the authorization request was canceled. Refusing to generate or rotate the signing key. Unlock the login keychain and retry.",
    );
  }
  const existingKeychainKey = lookupClass.status === "present" ? lookupClass.publicKey : null;

  // 3. Enforce idempotency and mismatch checks
  let effectivePublicKey = null;

  if (configuredPublicKey && existingKeychainKey) {
    if (configuredPublicKey !== existingKeychainKey) {
      throw new Error(
        "Sanitized error: Key mismatch! Keychain public key does not match desktop/update-config.json. Halting to prevent key rotation mismatch.",
      );
    }
    console.log(
      "[keyprep] Existing key in Keychain matches desktop/update-config.json. Preserving identity.",
    );
    effectivePublicKey = existingKeychainKey;
  } else if (configuredPublicKey && !existingKeychainKey) {
    throw new Error(
      "Sanitized error: desktop/update-config.json has a publicEdKey, but no matching key was found in Keychain. Cannot recover private key without manual intervention.",
    );
  } else if (!configuredPublicKey && existingKeychainKey) {
    console.log(
      "[keyprep] Found existing key in Keychain. Adopting for update-config.json without rotation.",
    );
    effectivePublicKey = existingKeychainKey;
  } else {
    // No key anywhere — generate a new one in the Keychain
    console.log("[keyprep] No existing key found. Generating new Ed25519 key in macOS Keychain…");
    const genResult = await runTool(genBin, ["--account", account]);
    assertToolSuccess(
      genResult,
      "Sanitized error: Failed to generate new Sparkle key in Keychain.",
    );

    // Retrieve the generated public key
    const lookup2 = await runTool(genBin, ["-p", "--account", account]);
    const lookup2Class = classifyKeychainLookup(lookup2);
    if (lookup2Class.status === "denied") {
      throw new Error(
        "Sanitized error: Keychain access was denied or the authorization request was canceled after generation. Refusing to continue.",
      );
    }
    if (lookup2Class.status !== "present") {
      throw new Error(
        "Sanitized error: Failed to retrieve newly generated public key from Keychain.",
      );
    }
    effectivePublicKey = lookup2Class.publicKey;
  }

  if (!effectivePublicKey) {
    throw new Error("Sanitized error: Could not obtain public Ed25519 key.");
  }

  const fingerprint = computeKeyFingerprint(effectivePublicKey);
  console.log(`[keyprep] Public Key (SUPublicEDKey): ${effectivePublicKey}`);
  console.log(`[keyprep] Public Key Fingerprint:   ${fingerprint}`);

  // 4. Export private key from Keychain to a temporary 0600 file in a 0700 dir outside the repo
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkle-key-"));
  const tempKeyFile = path.join(tempDir, "sparkle.key");

  let secretBuffer = null;
  try {
    fs.chmodSync(tempDir, 0o700);

    const exportResult = await runTool(genBin, ["-x", tempKeyFile, "--account", account]);
    if (exportResult.code !== 0 || !fs.existsSync(tempKeyFile)) {
      throw new Error(
        "Sanitized error: Export from Keychain failed. Sensitive details suppressed.",
      );
    }

    try {
      fs.chmodSync(tempKeyFile, 0o600);
    } catch {}

    secretBuffer = fs.readFileSync(tempKeyFile);
    if (!secretBuffer || secretBuffer.length === 0) {
      throw new Error("Sanitized error: Exported key file is empty.");
    }

    // 5. Verify the exported private key matches the public key BEFORE any upload
    if (!verifyPrivateKeyMatchesPublic(secretBuffer, effectivePublicKey)) {
      throw new Error(
        "Sanitized error: Exported private key does not match the public key. Halting to prevent identity mismatch.",
      );
    }

    // 6. Persist the PUBLIC config BEFORE the gh upload so a failed upload can be retried
    //    without rotating the identity.
    config.publicEdKey = effectivePublicKey;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o644,
    });
    console.log(
      `[keyprep] Persisted public key to ${configPath} (before secret upload, retry-safe).`,
    );

    // 7. Pipe the secret into GitHub Secrets via STDIN (NO secret in argv!)
    console.log(`[keyprep] Setting GitHub Secret SPARKLE_PRIVATE_KEY on ${repo} via STDIN…`);
    await setSecret({ repo, secret: secretBuffer });
    console.log(`[keyprep] Successfully uploaded SPARKLE_PRIVATE_KEY secret to ${repo}.`);
  } finally {
    // 8. Zero memory and disk artifacts immediately (best-effort; not a physical shred guarantee)
    if (fs.existsSync(tempKeyFile)) {
      try {
        const stats = fs.statSync(tempKeyFile);
        fs.writeFileSync(tempKeyFile, Buffer.alloc(stats.size, 0));
        fs.unlinkSync(tempKeyFile);
      } catch {}
    }
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmdirSync(tempDir);
      } catch {}
    }
    if (secretBuffer) {
      secretBuffer.fill(0);
    }
  }

  return {
    success: true,
    publicKey: effectivePublicKey,
    fingerprint,
  };
}

// --------------------------------------------------------------------------
// Release flow (exported for synthetic-mock regression tests)
// --------------------------------------------------------------------------

/**
 * Parses a CLI flag in BOTH forms: --flag=value and --flag value.
 */
export function parseCliFlag(args, name) {
  const eqForm = args.find((a) => a.startsWith(`--${name}=`));
  if (eqForm) return eqForm.slice(`--${name}=`.length);
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < args.length && !String(args[idx + 1]).startsWith("--")) {
    return args[idx + 1];
  }
  return null;
}

/**
 * Signs the release ZIP and generates appcast.xml.
 *
 * Security/behavior contract:
 * - The SPARKLE_PRIVATE_KEY secret is verified against the configured publicEdKey
 *   (verifyPrivateKeyMatchesPublic) BEFORE any sign/key-use; mismatch halts.
 * - The private key is only ever piped via STDIN (--ed-key-file -), never argv.
 * - generate_appcast writes appcast.xml INTO the release directory; its stdout is
 *   diagnostics and is NEVER published as the feed. The tool-produced appcast.xml is
 *   read back and validated (RSS structure, sparkle:edSignature, ZIP + version) before
 *   being copied to dist/appcast.xml.
 *
 * Injectable for tests: resolveTool, runTool, configPath, distDir, privateKey.
 */
export async function runRelease(options = {}) {
  const resolveTool =
    options.resolveTool ||
    ((name) => resolveSparkleBinary(name, { architecture: SPARKLE_ARCHITECTURE }));
  const runTool = options.runTool || runSparkleTool;
  const configPath = options.configPath || CONFIG_PATH;
  const distDir = options.distDir || "dist";

  // Root package.json is the single source of truth for the version (currently 0.2.0)
  let rootVersion = "0.2.0";
  try {
    rootVersion =
      JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")).version ||
      rootVersion;
  } catch {}
  const version = options.version || rootVersion;
  if (options.version && options.version !== rootVersion) {
    throw new Error("Sanitized error: --version does not match the root package.json version.");
  }

  // Feed URL / archive URL come from the VALIDATED config — no undeclared default.
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    throw new Error("Sanitized error: Failed to parse update-config.json");
  }
  const plan = buildReleasePlan({
    config,
    version,
    distDir,
    feedUrlOverride: options.feedUrlOverride || null,
    repo: options.repo,
  });

  const privateKey =
    options.privateKey != null ? options.privateKey : process.env.SPARKLE_PRIVATE_KEY;
  if (!privateKey || String(privateKey).trim().length === 0) {
    throw new Error("SPARKLE_PRIVATE_KEY environment variable is not set");
  }

  // Reject a secret that does not match the configured public key BEFORE any sign/key-use
  if (!verifyPrivateKeyMatchesPublic(Buffer.from(String(privateKey), "utf8"), plan.publicEdKey)) {
    throw new Error(
      "Sanitized error: SPARKLE_PRIVATE_KEY does not match the publicEdKey in update-config.json. Refusing to sign.",
    );
  }

  if (!fs.existsSync(plan.zipPath) || fs.statSync(plan.zipPath).size === 0) {
    throw new Error(`ZIP archive not found or empty: ${plan.zipPath}`);
  }

  // 1. Sign the ZIP archive — private key via STDIN only (--ed-key-file -), never in argv
  console.log(`[release] Signing ${plan.zipName}...`);
  const signUpdateBin = await resolveTool("sign-update");
  const signResult = await runTool(signUpdateBin, ["--ed-key-file", "-", plan.zipPath], {
    input: privateKey,
  });
  assertToolSuccess(signResult, "Sanitized error: Failed to sign archive.");
  console.log(`[release] Successfully signed ${plan.zipName}`);

  // 2. Generate appcast.xml with ONLY the ZIP (no DMG duplicate in the feed)
  console.log("[release] Generating appcast.xml...");
  const tempReleaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkle-release-"));
  try {
    fs.copyFileSync(plan.zipPath, path.join(tempReleaseDir, plan.zipName));

    const generateAppcastBin = await resolveTool("generate-appcast");
    const appcastResult = await runTool(
      generateAppcastBin,
      ["--download-url-prefix", plan.downloadUrlPrefix, "--ed-key-file", "-", tempReleaseDir],
      { input: privateKey },
    );
    assertToolSuccess(appcastResult, "Sanitized error: Failed to generate appcast.");

    // generate_appcast writes appcast.xml into the release directory; stdout is diagnostics only
    const producedAppcastPath = path.join(tempReleaseDir, "appcast.xml");
    if (!fs.existsSync(producedAppcastPath) || fs.statSync(producedAppcastPath).size === 0) {
      throw new Error(
        "Sanitized error: generate_appcast did not produce appcast.xml in the release directory.",
      );
    }
    const appcastXml = fs.readFileSync(producedAppcastPath, "utf8");
    // Validate the tool-produced feed before publishing: RSS structure, Ed25519 signature
    // attribute, and references to the signed ZIP archive + version. Never publish stdout.
    for (const required of [
      "<rss",
      "<channel",
      "sparkle:edSignature",
      plan.zipName,
      plan.version,
    ]) {
      if (!appcastXml.includes(required)) {
        throw new Error(
          "Sanitized error: Generated appcast.xml is missing required feed/signature content.",
        );
      }
    }

    fs.writeFileSync(plan.appcastPath, appcastXml, "utf8");
    console.log(`[release] Generated ${plan.appcastPath}`);
    return { plan, zipPath: plan.zipPath, appcastPath: plan.appcastPath };
  } finally {
    try {
      fs.rmSync(tempReleaseDir, { recursive: true, force: true });
    } catch {}
  }
}

// --------------------------------------------------------------------------
// CLI Entrypoint
// --------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "help";

  if (command === "help" || command === "--help" || command === "-h") {
    console.log(`
Usage: node desktop/update-tools.mjs <command> [options]

Commands:
  plan-keyprep              Print security review plan and exact Sparkle CLI commands
  keyprep [--execute]       Run idempotent key preparation (requires --execute after review)
  verify-config             Validate desktop/update-config.json structure and keys
  sign-command <archive>    Print exact sign_update command for given archive
  appcast-command <dir>     Print exact generate_appcast command for release directory
  release [--version=X.Y.Z] [--dist-dir=dist] [--feed-url=URL]  Sign ZIP and generate appcast.xml (only ZIP).
                            Version defaults to the root package.json version; feed URL and
                            archive URL come from the validated desktop/update-config.json.
  help                      Show this help message
`);
    process.exit(0);
  }

  if (command === "plan-keyprep") {
    printKeyprepPlan();
    process.exit(0);
  }

  if (command === "keyprep") {
    const hasExecute = args.includes("--execute");
    if (!hasExecute) {
      console.log("[keyprep] DRY RUN: --execute flag not provided. Showing plan instead.");
      printKeyprepPlan();
      process.exit(0);
    }

    try {
      await executeKeyprep();
      console.log("[keyprep] Key preparation finished successfully.");
      process.exit(0);
    } catch (err) {
      // NEVER echo raw error stdout/stderr or internal stack
      console.error(err.message || "Sanitized error: Key preparation aborted.");
      process.exit(1);
    }
  }

  if (command === "verify-config") {
    if (!fs.existsSync(CONFIG_PATH)) {
      console.error(`Config file not found at: ${CONFIG_PATH}`);
      process.exit(1);
    }
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    const result = validateUpdateConfig(config);
    if (!result.valid) {
      console.error("Config verification failed:");
      for (const err of result.errors) {
        console.error(` - ${err}`);
      }
      process.exit(1);
    }
    console.log("Config verification passed:");
    console.log(` - Feed URL: ${config.feedUrl}`);
    console.log(` - Public Key: ${config.publicEdKey}`);
    console.log(` - Fingerprint: ${computeKeyFingerprint(config.publicEdKey)}`);
    process.exit(0);
  }

  if (command === "sign-command") {
    const archive = args[1] || "dist/Sumi-0.2.0-macos-arm64.zip";
    console.log(buildSignCommand(archive));
    process.exit(0);
  }

  if (command === "appcast-command") {
    const dir = args[1] || "dist/releases";
    console.log(buildAppcastCommand(dir));
    process.exit(0);
  }

  if (command === "release") {
    // Accept both --flag=value and --flag value forms
    const version = parseCliFlag(args, "version");
    const distDir = parseCliFlag(args, "dist-dir") || "dist";
    const feedUrl = parseCliFlag(args, "feed-url");
    try {
      const result = await runRelease({
        version,
        distDir,
        feedUrlOverride: feedUrl,
        privateKey: process.env.SPARKLE_PRIVATE_KEY,
      });
      console.log(`[release] Feed URL (validated config): ${result.plan.feedUrl}`);
      console.log("[release] Release artifacts signed and appcast generated successfully.");
      process.exit(0);
    } catch (err) {
      // NEVER echo raw tool stdout/stderr; err.message is already sanitized
      console.error(err.message || "Sanitized error: Release failed.");
      process.exit(1);
    }
  }

  console.error(`Unknown command: ${command}. Use 'help' for usage.`);
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error("Sanitized error: Operation failed.");
    process.exit(1);
  });
}
