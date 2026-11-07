import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  DEFAULT_FEED_URL,
  ELECTRON_VERSION,
  REQUIRED_DESKTOP_SCRIPTS,
  assertFrameworkSymlinksConfined,
  buildEntitlementsXml,
  buildFrameworkInfoPlist,
  buildHelperInfoPlist,
  buildInfoPlist,
  checkRequiredScripts,
  parseShaSums,
  resolveUpdateConfig,
  validateFeedUrl,
  validatePublicEdKey,
} from "./build.mjs";

import {
  checkNoPrivateFiles,
  checkSelfContainedSymlinks,
  extractPlistValue,
  resolveArtifactNames,
  verifyBuiltApp,
} from "./package.mjs";

import { getReleaseMetadata } from "./release.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Valid raw 32-byte base64 Ed25519 public key for tests
const VALID_TEST_ED_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");

test("root package.json establishes version 0.2.0 single source of truth and script boundaries", () => {
  const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(rootPkg.version, "0.2.0", "Root package.json version must be 0.2.0");
  assert.equal(rootPkg.scripts["desktop:build"], "node desktop/build.mjs");
  assert.equal(rootPkg.scripts["desktop:open"], "open dist/Sumi.app");
  assert.equal(rootPkg.scripts["desktop:check"], "node --test desktop/check.test.mjs");
  assert.equal(rootPkg.scripts["desktop:package"], "node desktop/package.mjs");

  // Core packages must not be bumped
  const corePkg = JSON.parse(readFileSync(join(root, "packages/core/package.json"), "utf8"));
  assert.equal(corePkg.version, "0.1.0", "packages/core version must remain untouched");
  const webPkg = JSON.parse(readFileSync(join(root, "apps/web/package.json"), "utf8"));
  assert.equal(webPkg.version, "0.1.0", "apps/web version must remain untouched");
});

test("Electron pin and SHASUMS parser contract", () => {
  assert.equal(ELECTRON_VERSION, "45.2.3", "Pinned Electron version must be 45.2.3");

  const sampleSums = `
4d7c429064087a47b855d9bd06c76ead4819b7f02b385de232d4a5c37ecef55f *electron-v45.2.3-darwin-arm64.zip
e619dacecaeda36f4bc708ac7df5a6bdcdfe2f554d5a4f5c0f47bcd66d51a86c  electron-v45.2.3-darwin-x64.zip
`;
  const arm64Hash = parseShaSums(sampleSums, "electron-v45.2.3-darwin-arm64.zip");
  assert.equal(arm64Hash, "4d7c429064087a47b855d9bd06c76ead4819b7f02b385de232d4a5c37ecef55f");

  const x64Hash = parseShaSums(sampleSums, "electron-v45.2.3-darwin-x64.zip");
  assert.equal(x64Hash, "e619dacecaeda36f4bc708ac7df5a6bdcdfe2f554d5a4f5c0f47bcd66d51a86c");

  assert.equal(parseShaSums(sampleSums, "nonexistent.zip"), null);
});

test("required desktop scripts check fails loudly when any script is missing", () => {
  assert.deepEqual(REQUIRED_DESKTOP_SCRIPTS, [
    "main.cjs",
    "preload.cjs",
    "preferences.cjs",
    "security.cjs",
    "update-service.cjs",
  ]);

  const tempDir = mkdtempSync(join(tmpdir(), "sumi-scripts-check-"));
  try {
    writeFileSync(join(tempDir, "main.cjs"), "");
    writeFileSync(join(tempDir, "preload.cjs"), "");
    writeFileSync(join(tempDir, "preferences.cjs"), "");
    writeFileSync(join(tempDir, "security.cjs"), "");

    // Missing update-service.cjs must throw
    assert.throws(
      () => checkRequiredScripts(tempDir),
      /Required desktop script missing: desktop\/update-service\.cjs/,
    );

    writeFileSync(join(tempDir, "update-service.cjs"), "");
    assert.doesNotThrow(() => checkRequiredScripts(tempDir));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Info.plist generated schema passes plutil lint and adheres to permissions contracts", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "sumi-plist-check-"));
  try {
    const plistXml = buildInfoPlist("0.2.0", {
      suFeedUrl: "https://github.com/xolah88457/trade-journal/releases/latest/download/appcast.xml",
      suPublicEDKey: VALID_TEST_ED_KEY,
    });

    const plistPath = join(tempDir, "Info.plist");
    writeFileSync(plistPath, plistXml, "utf8");

    // Lint with macOS plutil
    execFileSync("plutil", ["-lint", plistPath]);

    // Key assertions
    assert.equal(extractPlistValue(plistXml, "CFBundleExecutable"), "Sumi");
    assert.equal(extractPlistValue(plistXml, "CFBundleDisplayName"), "Sumi");
    assert.equal(extractPlistValue(plistXml, "CFBundleName"), "Sumi");
    assert.equal(extractPlistValue(plistXml, "CFBundleIdentifier"), "local.sumi.journal");
    assert.equal(extractPlistValue(plistXml, "CFBundleShortVersionString"), "0.2.0");
    assert.equal(extractPlistValue(plistXml, "CFBundleVersion"), "0.2.0");
    assert.equal(extractPlistValue(plistXml, "CFBundleIconFile"), "Sumi");
    assert.equal(extractPlistValue(plistXml, "LSMinimumSystemVersion"), "14.0");

    // Voice dictation granted
    assert.match(
      plistXml,
      /<key>NSMicrophoneUsageDescription<\/key>\s*<string>[^<]+<\/string>/,
      "NSMicrophoneUsageDescription must be present",
    );

    // Camera strictly NOT granted
    assert.doesNotMatch(
      plistXml,
      /<key>NSCameraUsageDescription<\/key>/,
      "Camera must NOT be granted",
    );

    // Sparkle updater keys
    assert.equal(
      extractPlistValue(plistXml, "SUFeedURL"),
      "https://github.com/xolah88457/trade-journal/releases/latest/download/appcast.xml",
    );
    assert.equal(extractPlistValue(plistXml, "SUPublicEDKey"), VALID_TEST_ED_KEY);
    assert.match(plistXml, /<key>SUEnableAutomaticChecks<\/key>\s*<false\/>/);
    assert.match(plistXml, /<key>SUAutomaticallyUpdate<\/key>\s*<false\/>/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("helper and framework Info.plists match local.sumi.journal bundle identifier hierarchy", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "sumi-helpers-check-"));
  try {
    const helperXml = buildHelperInfoPlist(
      "local.sumi.journal.helper.renderer",
      "Electron Helper (Renderer)",
      "0.2.0",
    );
    const helperPlist = join(tempDir, "Helper-Info.plist");
    writeFileSync(helperPlist, helperXml, "utf8");
    execFileSync("plutil", ["-lint", helperPlist]);
    assert.equal(
      extractPlistValue(helperXml, "CFBundleIdentifier"),
      "local.sumi.journal.helper.renderer",
    );
    assert.equal(extractPlistValue(helperXml, "CFBundleShortVersionString"), "0.2.0");

    // The Electron Framework plist carries the VENDOR (Electron) version,
    // not the root app version - build.mjs must stamp pinned ELECTRON_VERSION.
    const fwXml = buildFrameworkInfoPlist(ELECTRON_VERSION);
    const fwPlist = join(tempDir, "Fw-Info.plist");
    writeFileSync(fwPlist, fwXml, "utf8");
    execFileSync("plutil", ["-lint", fwPlist]);
    assert.equal(extractPlistValue(fwXml, "CFBundleIdentifier"), "local.sumi.journal.framework");
    assert.equal(extractPlistValue(fwXml, "CFBundleExecutable"), "Electron Framework");
    assert.equal(extractPlistValue(fwXml, "CFBundleShortVersionString"), "45.2.3");
    assert.equal(extractPlistValue(fwXml, "CFBundleVersion"), "45.2.3");

    // Guard the call site: build.mjs must pass ELECTRON_VERSION (not appVersion)
    // to buildFrameworkInfoPlist so the packaged framework metadata pins 45.2.3.
    const buildSource = readFileSync(join(root, "desktop/build.mjs"), "utf8");
    assert.match(
      buildSource,
      /buildFrameworkInfoPlist\(ELECTRON_VERSION\)/,
      "build.mjs must stamp the Electron Framework plist with ELECTRON_VERSION",
    );
    assert.doesNotMatch(
      buildSource,
      /buildFrameworkInfoPlist\(appVersion\)/,
      "build.mjs must NOT stamp the framework plist with the root app version",
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("entitlements XML enables arm64 Electron JIT and microphone without camera grant", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "sumi-entitlements-check-"));
  try {
    const entitlements = buildEntitlementsXml();
    const entPath = join(tempDir, "entitlements.plist");
    writeFileSync(entPath, entitlements, "utf8");
    execFileSync("plutil", ["-lint", entPath]);

    assert.match(entitlements, /<key>com\.apple\.security\.cs\.allow-jit<\/key>\s*<true\/>/);
    assert.match(
      entitlements,
      /<key>com\.apple\.security\.cs\.allow-unsigned-executable-memory<\/key>\s*<true\/>/,
    );
    assert.match(entitlements, /<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\/>/);
    assert.doesNotMatch(entitlements, /<key>com\.apple\.security\.device\.camera<\/key>/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("artifact naming resolves version and architecture bound outputs", () => {
  const arm64Names = resolveArtifactNames("0.2.0", "arm64");
  assert.equal(arm64Names.zipName, "Sumi-0.2.0-macos-arm64.zip");
  assert.equal(arm64Names.dmgName, "Sumi-0.2.0-macos-arm64.dmg");

  const x64Names = resolveArtifactNames("0.2.0", "x64");
  assert.equal(x64Names.zipName, "Sumi-0.2.0-macos-x64.zip");
  assert.equal(x64Names.dmgName, "Sumi-0.2.0-macos-x64.dmg");

  const meta = getReleaseMetadata();
  assert.equal(meta.version, "0.2.0");
  assert.equal(meta.zipName, `Sumi-0.2.0-macos-${process.arch === "arm64" ? "arm64" : "x64"}.zip`);
});

test("distribution security checks enforce model, private file, and symlink boundaries", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "sumi-dist-sec-"));
  try {
    // Permitted file and model
    writeFileSync(join(tempDir, "silero-vad-v6.2-F32.gguf"), "dummy vad");
    writeFileSync(join(tempDir, "server.js"), "console.log()");
    assert.doesNotThrow(() => checkNoPrivateFiles(tempDir));

    // Reject .env files
    const envFile = join(tempDir, ".env.production");
    writeFileSync(envFile, "SECRET=1");
    assert.throws(() => checkNoPrivateFiles(tempDir), /Environment file bundled in distribution/);
    rmSync(envFile);

    // Reject SQLite databases
    const dbFile = join(tempDir, "journal.sqlite");
    writeFileSync(dbFile, "sqlite format");
    assert.throws(() => checkNoPrivateFiles(tempDir), /Database bundled in distribution/);
    rmSync(dbFile);

    // Reject unapproved heavy GGUF models
    const heavyModel = join(tempDir, "parakeet-unified-en-0.6b-Q8_0.gguf");
    writeFileSync(heavyModel, "heavy weights");
    assert.throws(() => checkNoPrivateFiles(tempDir), /Forbidden model weights bundled/);
    rmSync(heavyModel);

    // Reject escaping symlinks
    const outside = mkdtempSync(join(tmpdir(), "sumi-outside-"));
    const escapeLink = join(tempDir, "escape-link");
    symlinkSync(outside, escapeLink);
    assert.throws(
      () => checkSelfContainedSymlinks(tempDir, tempDir + "/"),
      /Symlink escapes application bundle/,
    );
    rmSync(escapeLink);
    rmSync(outside, { recursive: true, force: true });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("framework symlinks confinement check detects escaping links", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "sumi-framework-check-"));
  try {
    const fwDir = join(tempDir, "Test.framework");
    const versionsDir = join(fwDir, "Versions", "A");
    mkdirSync(versionsDir, { recursive: true });
    writeFileSync(join(versionsDir, "Test"), "binary");

    // Internal symlink: OK
    symlinkSync("A", join(fwDir, "Versions", "Current"));
    symlinkSync("Versions/Current/Test", join(fwDir, "Test"));
    assert.doesNotThrow(() => assertFrameworkSymlinksConfined(fwDir));

    // Escaping symlink: MUST FAIL
    const outside = mkdtempSync(join(tmpdir(), "sumi-fw-outside-"));
    const escapeSymlink = join(fwDir, "EscapingLink");
    symlinkSync(outside, escapeSymlink);
    assert.throws(() => assertFrameworkSymlinksConfined(fwDir), /Framework symlink escapes bundle/);

    rmSync(escapeSymlink);
    rmSync(outside, { recursive: true, force: true });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("packaging helper verifies app presence and version match before packaging", () => {
  const nonexistent = join(tmpdir(), "Nonexistent.app");
  assert.throws(() => verifyBuiltApp(nonexistent, "0.2.0"), /Built application missing/);

  const mockApp = mkdtempSync(join(tmpdir(), "Mock.app-"));
  const appContents = join(mockApp, "Contents");
  mkdirSync(join(appContents, "MacOS"), { recursive: true });
  try {
    writeFileSync(
      join(appContents, "Info.plist"),
      // mismatch: 0.1.0 instead of 0.2.0 (valid key required - never omitted)
      buildInfoPlist("0.1.0", { suPublicEDKey: VALID_TEST_ED_KEY }),
      "utf8",
    );
    writeFileSync(join(appContents, "MacOS", "Sumi"), "#!/bin/sh\nexit 0\n");

    assert.throws(
      () => verifyBuiltApp(mockApp, "0.2.0"),
      /Version mismatch: package\.json specifies 0\.2\.0 but Sumi\.app Info\.plist contains 0\.1\.0/,
    );
  } finally {
    rmSync(mockApp, { recursive: true, force: true });
  }
});

test("THIRD-PARTY-NOTICES.md retains all required notices including Electron, Sparkle, fflate, Silero, and transcribe.cpp", () => {
  const notices = readFileSync(join(root, "desktop/THIRD-PARTY-NOTICES.md"), "utf8");
  assert.match(notices, /Electron/, "Electron notice missing");
  assert.match(notices, /LICENSES\.chromium\.html/, "Chromium license notice missing");
  assert.match(notices, /Sparkle/, "Sparkle notice missing");
  assert.match(notices, /fflate/, "fflate notice missing");
  assert.match(notices, /LuxAlgo Trade Journal/, "Trade Journal notice missing");
  assert.match(notices, /Kami/, "Kami notice missing");
  assert.match(notices, /Node\.js/, "Node notice missing");
  assert.match(notices, /transcribe\.cpp/, "transcribe.cpp notice missing");
  assert.match(notices, /Silero VAD/, "Silero VAD notice missing");
});

test("validatePublicEdKey enforces valid raw 32-byte base64 Ed25519 public key", () => {
  // Empty key throws
  assert.throws(() => validatePublicEdKey(""), /SUPublicEDKey is required/);
  assert.throws(() => validatePublicEdKey(null), /SUPublicEDKey is required/);
  assert.throws(() => validatePublicEdKey(undefined), /SUPublicEDKey is required/);
  assert.throws(() => validatePublicEdKey("   "), /SUPublicEDKey is required/);

  // Invalid base64 throws (contains characters that make base64 decode fail)
  assert.throws(() => validatePublicEdKey("not base64!"), /SUPublicEDKey must be valid base64/);

  // Wrong byte length throws
  const shortKey = Buffer.from(new Uint8Array(16)).toString("base64"); // 16 bytes
  assert.throws(() => validatePublicEdKey(shortKey), /must decode to exactly 32 bytes/);
  const longKey = Buffer.from(new Uint8Array(64)).toString("base64"); // 64 bytes
  assert.throws(() => validatePublicEdKey(longKey), /must decode to exactly 32 bytes/);

  // Valid 32-byte base64 key accepted
  const validKey = Buffer.from(new Uint8Array(32)).toString("base64");
  const result = validatePublicEdKey(validKey);
  assert.equal(result, validKey.trim());

  // Valid key with whitespace trimmed
  const resultWithSpace = validatePublicEdKey("  " + validKey + "  ");
  assert.equal(resultWithSpace, validKey.trim());
});

test("validateFeedUrl requires a valid HTTPS feed URL", () => {
  assert.equal(
    validateFeedUrl(
      "https://github.com/xolah88457/trade-journal/releases/latest/download/appcast.xml",
    ),
    "https://github.com/xolah88457/trade-journal/releases/latest/download/appcast.xml",
  );
  // Plain HTTP must throw
  assert.throws(() => validateFeedUrl("http://example.com/appcast.xml"), /must use HTTPS/);
  // Empty / missing / garbage must throw
  assert.throws(() => validateFeedUrl(""), /feedUrl is required/);
  assert.throws(() => validateFeedUrl(null), /feedUrl is required/);
  assert.throws(() => validateFeedUrl("not a url"), /must be a valid URL/);
  assert.throws(() => validateFeedUrl("ftp://example.com/appcast.xml"), /must use HTTPS/);
});

test("resolveUpdateConfig throws on empty/invalid publicEdKey and non-HTTPS feed BEFORE any build step", () => {
  // The canonical desktop/update-config.json now carries the PROVISIONED public
  // Ed25519 key (key prep succeeded) - it must resolve to a valid non-empty key.
  // Do NOT assert the real config is empty: the empty-key case is covered below
  // with an explicit fixture so the test holds on any checkout state.
  const realConfig = JSON.parse(readFileSync(join(root, "desktop/update-config.json"), "utf8"));
  const provisioned = resolveUpdateConfig({ config: realConfig, env: {} });
  assert.ok(
    provisioned.publicEdKey.length > 0,
    "provisioned config must have a non-empty publicEdKey",
  );
  assert.equal(provisioned.publicEdKey, validatePublicEdKey(realConfig.publicEdKey));
  assert.equal(provisioned.feedUrl, realConfig.feedUrl);

  // Empty key (fixture derived from the real config) MUST throw, so an
  // unprovisioned stub fails the build before Next build / download / staging.
  assert.throws(
    () => resolveUpdateConfig({ config: { ...realConfig, publicEdKey: "" }, env: {} }),
    /SUPublicEDKey is required/,
  );

  // Empty key with https feed still throws
  assert.throws(
    () =>
      resolveUpdateConfig({
        config: { feedUrl: "https://example.com/appcast.xml", publicEdKey: "" },
        env: {},
      }),
    /SUPublicEDKey is required/,
  );

  // Non-HTTPS feed throws even with a valid key
  assert.throws(
    () =>
      resolveUpdateConfig({
        config: { feedUrl: "http://example.com/appcast.xml", publicEdKey: VALID_TEST_ED_KEY },
        env: {},
      }),
    /must use HTTPS/,
  );

  // Invalid key material throws
  assert.throws(
    () =>
      resolveUpdateConfig({
        config: { feedUrl: "https://example.com/appcast.xml", publicEdKey: "not base64!" },
        env: {},
      }),
    /SUPublicEDKey must be valid base64/,
  );

  // Valid canonical config resolves
  const resolved = resolveUpdateConfig({
    config: { feedUrl: "https://example.com/appcast.xml", publicEdKey: VALID_TEST_ED_KEY },
    env: {},
  });
  assert.equal(resolved.feedUrl, "https://example.com/appcast.xml");
  assert.equal(resolved.publicEdKey, VALID_TEST_ED_KEY);

  // Env override wins over config; missing feedUrl defaults to DEFAULT_FEED_URL
  const envResolved = resolveUpdateConfig({
    config: { feedUrl: "https://config.example/appcast.xml", publicEdKey: VALID_TEST_ED_KEY },
    env: {
      SUMI_FEED_URL: "https://env.example/appcast.xml",
      SUMI_PUBLIC_ED_KEY: VALID_TEST_ED_KEY,
    },
  });
  assert.equal(envResolved.feedUrl, "https://env.example/appcast.xml");
  const defaultFeed = resolveUpdateConfig({ config: { publicEdKey: VALID_TEST_ED_KEY }, env: {} });
  assert.equal(defaultFeed.feedUrl, DEFAULT_FEED_URL);
});

test("buildInfoPlist NEVER omits SUPublicEDKey and validates feed + key", () => {
  // Empty key must throw - the key is always emitted
  assert.throws(
    () => buildInfoPlist("0.2.0", { suFeedUrl: DEFAULT_FEED_URL, suPublicEDKey: "" }),
    /SUPublicEDKey is required/,
  );
  assert.throws(() => buildInfoPlist("0.2.0"), /SUPublicEDKey is required/);
  // Non-HTTPS feed must throw
  assert.throws(
    () =>
      buildInfoPlist("0.2.0", {
        suFeedUrl: "http://example.com/appcast.xml",
        suPublicEDKey: VALID_TEST_ED_KEY,
      }),
    /must use HTTPS/,
  );

  const xml = buildInfoPlist("0.2.0", {
    suFeedUrl: "https://example.com/appcast.xml",
    suPublicEDKey: VALID_TEST_ED_KEY,
  });
  // SUPublicEDKey is ALWAYS present in the generated plist
  assert.match(xml, /<key>SUPublicEDKey<\/key>\s*<string>[A-Za-z0-9+/=]+<\/string>/);
  assert.equal(extractPlistValue(xml, "SUPublicEDKey"), VALID_TEST_ED_KEY);
  assert.equal(extractPlistValue(xml, "SUFeedURL"), "https://example.com/appcast.xml");
});
