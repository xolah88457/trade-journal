import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  APP_UPDATE_CONFIG,
  DEFAULT_FEED_URL,
  DEFAULT_X64_FEED_URL,
  ELECTRON_VERSION,
  PINNED_ELECTRON_CHECKSUMS,
  REQUIRED_DESKTOP_SCRIPTS,
  REQUIRED_WIN32_CRT_DLLS,
  SILERO_EXPECTED_SHA256,
  SUPPORTED_PLATFORMS,
  assertFrameworkSymlinksConfined,
  assertKoffiPayload,
  assertSelfContained,
  augmentStandaloneDependencies,
  buildEntitlementsXml,
  buildFrameworkInfoPlist,
  buildHelperInfoPlist,
  buildInfoPlist,
  bundlePackageWithRuntimeDeps,
  checkRequiredScripts,
  cleanPrivateFiles,
  findOwningPackageJson,
  generateAppUpdateYaml,
  getElectronArchiveName,
  getKoffiPackageName,
  getNativeLibName,
  getNativeTuple,
  getNodeArchiveName,
  getNodeBinaryRelativePath,
  getPnpmCommand,
  isPathContained,
  parseShaSums,
  resolveKoffiNativeDir,
  resolveKoffiPackageDir,
  resolveMacFeedUrl,
  resolvePackage,
  resolveUpdateConfig,
  resolveWindowsCrtDlls,
  validateFeedUrl,
  validatePublicEdKey,
} from "./build.mjs";

import {
  DEBIAN_MAINTAINER,
  GITHUB_PUBLISH_CONFIG,
  checkNoPrivateFiles,
  checkSelfContainedSymlinks,
  extractPlistValue,
  mergeLinuxYml,
  packageApp,
  resolveArtifactNames,
  verifyBuiltApp,
} from "./package.mjs";

import { getExecutablePath, openApp } from "./open.mjs";
import { getReleaseMetadata } from "./release.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Valid raw 32-byte base64 Ed25519 public key for tests
const VALID_TEST_ED_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");

test("root package.json establishes version 0.3.0 single source of truth and script boundaries", () => {
  const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(rootPkg.version, "0.3.0", "Root package.json version must be 0.3.0");
  assert.equal(rootPkg.scripts["desktop:build"], "node desktop/build.mjs");
  assert.equal(rootPkg.scripts["desktop:open"], "node desktop/open.mjs");
  assert.equal(rootPkg.scripts["desktop:check"], "node --test desktop/check.test.mjs");
  assert.equal(rootPkg.scripts["desktop:package"], "node desktop/package.mjs");

  // Dependencies: electron-updater pinned at 6.8.11 for Win/Linux update adapter
  assert.equal(rootPkg.dependencies?.["electron-updater"], "6.8.11");

  // DevDependencies: electron-builder pinned at 26.18.0
  assert.equal(rootPkg.devDependencies?.["electron-builder"], "26.18.0");
  assert.equal(rootPkg.devDependencies?.["electron-sparkle"], "0.2.0");

  // Repository points to fork and author provides generic maintainer
  assert.equal(rootPkg.repository?.url, "git+https://github.com/xolah88457/trade-journal.git");
  assert.equal(rootPkg.author, "Sumi contributors <noreply@github.com>");

  // Core packages must not be bumped
  const corePkg = JSON.parse(readFileSync(join(root, "packages/core/package.json"), "utf8"));
  assert.equal(corePkg.version, "0.1.0", "packages/core version must remain untouched");
  const webPkg = JSON.parse(readFileSync(join(root, "apps/web/package.json"), "utf8"));
  assert.equal(webPkg.version, "0.1.0", "apps/web version must remain untouched");
});

test("Electron pin and SHASUMS parser contract across all supported platforms", () => {
  assert.equal(ELECTRON_VERSION, "45.2.3", "Pinned Electron version must be 45.2.3");

  const sampleSums = `
4d7c429064087a47b855d9bd06c76ead4819b7f02b385de232d4a5c37ecef55f *electron-v45.2.3-darwin-arm64.zip
d87323533cc8750ef177e5b48058f7a8b381f677d4e103cc63360006c08829c2  electron-v45.2.3-darwin-x64.zip
a87fe741f6d121285117e574da6c9a2e65210d410123bbc04713b099add0263b *electron-v45.2.3-linux-x64.zip
489cd061908e697394b004298bf5ffd345c935d10e8ca197ba819f019ab2dec0  electron-v45.2.3-win32-x64.zip
`;
  const arm64Hash = parseShaSums(sampleSums, "electron-v45.2.3-darwin-arm64.zip");
  assert.equal(arm64Hash, "4d7c429064087a47b855d9bd06c76ead4819b7f02b385de232d4a5c37ecef55f");

  const x64Hash = parseShaSums(sampleSums, "electron-v45.2.3-darwin-x64.zip");
  assert.equal(x64Hash, "d87323533cc8750ef177e5b48058f7a8b381f677d4e103cc63360006c08829c2");

  const linuxHash = parseShaSums(sampleSums, "electron-v45.2.3-linux-x64.zip");
  assert.equal(linuxHash, "a87fe741f6d121285117e574da6c9a2e65210d410123bbc04713b099add0263b");

  const winHash = parseShaSums(sampleSums, "electron-v45.2.3-win32-x64.zip");
  assert.equal(winHash, "489cd061908e697394b004298bf5ffd345c935d10e8ca197ba819f019ab2dec0");

  assert.equal(parseShaSums(sampleSums, "nonexistent.zip"), null);

  // Pinned checksums dictionary must carry genuine official hashes for all release targets
  assert.equal(
    PINNED_ELECTRON_CHECKSUMS["darwin-arm64"],
    "4d7c429064087a47b855d9bd06c76ead4819b7f02b385de232d4a5c37ecef55f",
  );
  assert.equal(
    PINNED_ELECTRON_CHECKSUMS["darwin-x64"],
    "d87323533cc8750ef177e5b48058f7a8b381f677d4e103cc63360006c08829c2",
  );
  assert.equal(
    PINNED_ELECTRON_CHECKSUMS["linux-x64"],
    "a87fe741f6d121285117e574da6c9a2e65210d410123bbc04713b099add0263b",
  );
  assert.equal(
    PINNED_ELECTRON_CHECKSUMS["win32-x64"],
    "489cd061908e697394b004298bf5ffd345c935d10e8ca197ba819f019ab2dec0",
  );

  // Archive name resolution per platform/arch
  assert.equal(
    getElectronArchiveName("45.2.3", "darwin", "arm64"),
    "electron-v45.2.3-darwin-arm64.zip",
  );
  assert.equal(
    getElectronArchiveName("45.2.3", "darwin", "x64"),
    "electron-v45.2.3-darwin-x64.zip",
  );
  assert.equal(getElectronArchiveName("45.2.3", "linux", "x64"), "electron-v45.2.3-linux-x64.zip");
  assert.equal(getElectronArchiveName("45.2.3", "win32", "x64"), "electron-v45.2.3-win32-x64.zip");
});

test("Node archive download naming and binary layout across platforms", () => {
  const version = "v26.13.0";
  assert.equal(getNodeArchiveName(version, "darwin", "arm64"), "node-v26.13.0-darwin-arm64.tar.gz");
  assert.equal(getNodeArchiveName(version, "darwin", "x64"), "node-v26.13.0-darwin-x64.tar.gz");
  assert.equal(getNodeArchiveName(version, "linux", "x64"), "node-v26.13.0-linux-x64.tar.gz");
  assert.equal(getNodeArchiveName(version, "win32", "x64"), "node-v26.13.0-win-x64.zip");

  assert.equal(getNodeBinaryRelativePath("darwin"), "bin/node");
  assert.equal(getNodeBinaryRelativePath("linux"), "bin/node");
  assert.equal(getNodeBinaryRelativePath("win32"), "node.exe");
});

test("native tuple, library name, and Koffi package mapping across supported host OS", () => {
  // Transcribe tuples
  assert.equal(getNativeTuple("darwin", "arm64"), "darwin-arm64-metal");
  assert.equal(getNativeTuple("darwin", "x64"), "darwin-x64-cpu");
  assert.equal(getNativeTuple("linux", "x64"), "linux-x64-cpu-vulkan");
  assert.equal(getNativeTuple("linux", "arm64"), "linux-arm64-cpu-vulkan");
  assert.equal(getNativeTuple("win32", "x64"), "win32-x64-cpu-vulkan");
  assert.equal(getNativeTuple("win32", "arm64"), null);

  // Library filenames
  assert.equal(getNativeLibName("darwin"), "libtranscribe.dylib");
  assert.equal(getNativeLibName("win32"), "transcribe.dll");
  assert.equal(getNativeLibName("linux"), "libtranscribe.so");

  // Koffi platform packages
  assert.equal(getKoffiPackageName("darwin", "arm64"), "@koromix/koffi-darwin-arm64");
  assert.equal(getKoffiPackageName("darwin", "x64"), "@koromix/koffi-darwin-x64");
  assert.equal(getKoffiPackageName("linux", "x64"), "@koromix/koffi-linux-x64");
  assert.equal(getKoffiPackageName("linux", "arm64"), "@koromix/koffi-linux-arm64");
  assert.equal(getKoffiPackageName("win32", "x64"), "@koromix/koffi-win32-x64");

  // Koffi native directory resolution finds installed package on host
  const koffiDir = resolveKoffiNativeDir(root, process.platform, process.arch);
  assert.ok(koffiDir, "Koffi native directory must resolve on host");
  assert.ok(existsSync(koffiDir), `Resolved Koffi dir must exist at ${koffiDir}`);
});

test("apps/web/next.config.ts externalizes all 5 verified transcribe-cpp tuples", () => {
  const nextConfigPath = join(root, "apps/web/next.config.ts");
  const content = readFileSync(nextConfigPath, "utf8");

  const requiredTuples = [
    "@transcribe-cpp/darwin-arm64-metal",
    "@transcribe-cpp/darwin-x64-cpu",
    "@transcribe-cpp/linux-x64-cpu-vulkan",
    "@transcribe-cpp/linux-arm64-cpu-vulkan",
    "@transcribe-cpp/win32-x64-cpu-vulkan",
  ];

  for (const tuple of requiredTuples) {
    assert.ok(
      content.includes(`"${tuple}"`) || content.includes(`'${tuple}'`),
      `next.config.ts serverExternalPackages must include ${tuple}`,
    );
  }
  assert.ok(content.includes('"better-sqlite3"'), "better-sqlite3 must be externalized");
  assert.ok(content.includes('"transcribe-cpp"'), "transcribe-cpp must be externalized");
  assert.ok(content.includes('"koffi"'), "koffi must be externalized");
});

test("required desktop scripts check fails loudly when any script is missing", () => {
  assert.deepEqual(REQUIRED_DESKTOP_SCRIPTS, [
    "main.cjs",
    "preload.cjs",
    "preferences.cjs",
    "security.cjs",
    "update-service.cjs",
    "update-service-platform.cjs",
  ]);

  const tempDir = mkdtempSync(join(tmpdir(), "sumi-scripts-check-"));
  try {
    writeFileSync(join(tempDir, "main.cjs"), "");
    writeFileSync(join(tempDir, "preload.cjs"), "");
    writeFileSync(join(tempDir, "preferences.cjs"), "");
    writeFileSync(join(tempDir, "security.cjs"), "");
    writeFileSync(join(tempDir, "update-service.cjs"), "");

    assert.throws(
      () => checkRequiredScripts(tempDir),
      /Required desktop script missing: desktop\/update-service-platform\.cjs/,
    );

    writeFileSync(join(tempDir, "update-service-platform.cjs"), "");
    assert.doesNotThrow(() => checkRequiredScripts(tempDir));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Info.plist generated schema passes plutil lint and adheres to permissions contracts", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "sumi-plist-check-"));
  try {
    const plistXml = buildInfoPlist("0.3.0", {
      suFeedUrl: "https://github.com/xolah88457/trade-journal/releases/latest/download/appcast.xml",
      suPublicEDKey: VALID_TEST_ED_KEY,
    });

    const plistPath = join(tempDir, "Info.plist");
    writeFileSync(plistPath, plistXml, "utf8");

    if (process.platform === "darwin") {
      execFileSync("plutil", ["-lint", plistPath]);
    }

    assert.equal(extractPlistValue(plistXml, "CFBundleExecutable"), "Sumi");
    assert.equal(extractPlistValue(plistXml, "CFBundleDisplayName"), "Sumi");
    assert.equal(extractPlistValue(plistXml, "CFBundleName"), "Sumi");
    assert.equal(extractPlistValue(plistXml, "CFBundleIdentifier"), "local.sumi.journal");
    assert.equal(extractPlistValue(plistXml, "CFBundleShortVersionString"), "0.3.0");
    assert.equal(extractPlistValue(plistXml, "CFBundleVersion"), "0.3.0");
    assert.equal(extractPlistValue(plistXml, "CFBundleIconFile"), "Sumi");
    assert.equal(extractPlistValue(plistXml, "LSMinimumSystemVersion"), "14.0");

    assert.match(
      plistXml,
      /<key>NSMicrophoneUsageDescription<\/key>\s*<string>[^<]+<\/string>/,
      "NSMicrophoneUsageDescription must be present",
    );

    assert.doesNotMatch(
      plistXml,
      /<key>NSCameraUsageDescription<\/key>/,
      "Camera must NOT be granted",
    );

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
      "0.3.0",
    );
    const helperPlist = join(tempDir, "Helper-Info.plist");
    writeFileSync(helperPlist, helperXml, "utf8");
    if (process.platform === "darwin") {
      execFileSync("plutil", ["-lint", helperPlist]);
    }
    assert.equal(
      extractPlistValue(helperXml, "CFBundleIdentifier"),
      "local.sumi.journal.helper.renderer",
    );
    assert.equal(extractPlistValue(helperXml, "CFBundleShortVersionString"), "0.3.0");

    const fwXml = buildFrameworkInfoPlist(ELECTRON_VERSION);
    const fwPlist = join(tempDir, "Fw-Info.plist");
    writeFileSync(fwPlist, fwXml, "utf8");
    if (process.platform === "darwin") {
      execFileSync("plutil", ["-lint", fwPlist]);
    }
    assert.equal(extractPlistValue(fwXml, "CFBundleIdentifier"), "local.sumi.journal.framework");
    assert.equal(extractPlistValue(fwXml, "CFBundleExecutable"), "Electron Framework");
    assert.equal(extractPlistValue(fwXml, "CFBundleShortVersionString"), "45.2.3");
    assert.equal(extractPlistValue(fwXml, "CFBundleVersion"), "45.2.3");

    const buildSource = readFileSync(join(root, "desktop/build.mjs"), "utf8");
    assert.match(
      buildSource,
      /buildFrameworkInfoPlist\(ELECTRON_VERSION\)/,
      "build.mjs must stamp the Electron Framework plist with ELECTRON_VERSION",
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
    if (process.platform === "darwin") {
      execFileSync("plutil", ["-lint", entPath]);
    }

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

test("Mac architecture feed split separates ARM and x64 feeds while preserving public keys", () => {
  assert.equal(
    resolveMacFeedUrl("https://example.com/releases/latest/download/appcast.xml", "arm64"),
    "https://example.com/releases/latest/download/appcast.xml",
  );
  assert.equal(
    resolveMacFeedUrl("https://example.com/releases/latest/download/appcast.xml", "x64"),
    "https://example.com/releases/latest/download/appcast-x64.xml",
  );

  const armConfig = resolveUpdateConfig({
    config: { publicEdKey: VALID_TEST_ED_KEY },
    env: {},
    arch: "arm64",
  });
  assert.equal(armConfig.feedUrl, DEFAULT_FEED_URL);

  const x64Config = resolveUpdateConfig({
    config: { publicEdKey: VALID_TEST_ED_KEY },
    env: {},
    arch: "x64",
  });
  assert.equal(x64Config.feedUrl, DEFAULT_X64_FEED_URL);

  // Custom feed mapping
  const mapped = resolveUpdateConfig({
    config: {
      feedUrl: "https://custom.org/latest/download/appcast.xml",
      publicEdKey: VALID_TEST_ED_KEY,
    },
    env: {},
    arch: "x64",
  });
  assert.equal(mapped.feedUrl, "https://custom.org/latest/download/appcast-x64.xml");
});

test("artifact naming resolves version, architecture, and platform bound outputs", () => {
  const arm64Names = resolveArtifactNames("0.3.0", "arm64", "darwin");
  assert.equal(arm64Names.zipName, "Sumi-0.3.0-macos-arm64.zip");
  assert.equal(arm64Names.dmgName, "Sumi-0.3.0-macos-arm64.dmg");

  const x64Names = resolveArtifactNames("0.3.0", "x64", "darwin");
  assert.equal(x64Names.zipName, "Sumi-0.3.0-macos-x64.zip");
  assert.equal(x64Names.dmgName, "Sumi-0.3.0-macos-x64.dmg");

  const winNames = resolveArtifactNames("0.3.0", "x64", "win32");
  assert.equal(winNames.nsisName, "Sumi-0.3.0-win32-x64-setup.exe");
  assert.equal(winNames.zipName, "Sumi-0.3.0-win32-x64.zip");

  const linuxNames = resolveArtifactNames("0.3.0", "x64", "linux");
  assert.equal(linuxNames.appImageName, "Sumi-0.3.0-linux-x64.AppImage");
  assert.equal(linuxNames.debName, "Sumi-0.3.0-linux-x64.deb");

  const meta = getReleaseMetadata();
  assert.equal(meta.version, "0.3.0");
  assert.equal(meta.platform, process.platform);
});

test("predictable executable path resolution and desktop:open helper", () => {
  const dummyDist = join(tmpdir(), "sumi-dist-test");

  assert.equal(getExecutablePath("darwin", "arm64", dummyDist), join(dummyDist, "Sumi.app"));
  assert.equal(getExecutablePath("darwin", "x64", dummyDist), join(dummyDist, "Sumi.app"));
  assert.equal(
    getExecutablePath("win32", "x64", dummyDist),
    join(dummyDist, "sumi-win32-x64", "Sumi.exe"),
  );
  assert.equal(
    getExecutablePath("linux", "x64", dummyDist),
    join(dummyDist, "sumi-linux-x64", "sumi"),
  );

  // Missing executable fails with clear instruction
  assert.throws(
    () => openApp({ throwOnMissing: true, distDir: dummyDist }),
    /No desktop build found at/,
  );
});

test("distribution security checks enforce model, private file, and symlink boundaries", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "sumi-dist-sec-"));

  try {
    writeFileSync(join(tempDir, "silero-vad-v6.2-F32.gguf"), "dummy vad");
    writeFileSync(join(tempDir, "server.js"), "console.log()");
    assert.doesNotThrow(() => checkNoPrivateFiles(tempDir));

    const envFile = join(tempDir, ".env.production");
    writeFileSync(envFile, "SECRET=1");
    assert.throws(() => checkNoPrivateFiles(tempDir), /Environment file bundled in distribution/);
    rmSync(envFile);

    const dbFile = join(tempDir, "journal.sqlite");
    writeFileSync(dbFile, "sqlite format");
    assert.throws(() => checkNoPrivateFiles(tempDir), /Database bundled in distribution/);
    rmSync(dbFile);

    const heavyModel = join(tempDir, "parakeet-unified-en-0.6b-Q8_0.gguf");
    writeFileSync(heavyModel, "heavy weights");
    assert.throws(() => checkNoPrivateFiles(tempDir), /Forbidden model weights bundled/);
    rmSync(heavyModel);

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

test("Silero VAD 1.2 MB verified hash is present and matches constant", () => {
  assert.equal(
    SILERO_EXPECTED_SHA256,
    "0d871a800c420fdd5d1b17a3aea4296d1c39608f0ff4a9295eb76457eb1c88e6",
  );
  const sileroPath = join(root, "models/silero-vad-v6.2-F32.gguf");
  assert.ok(existsSync(sileroPath), `Silero VAD model missing at ${sileroPath}`);
  const bytes = readFileSync(sileroPath);
  const hash = createHash("sha256").update(bytes).digest("hex");
  assert.equal(
    hash,
    SILERO_EXPECTED_SHA256,
    "Silero VAD SHA-256 hash must match official constant",
  );
});

test("framework symlinks confinement check detects escaping links", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "sumi-framework-check-"));
  try {
    const fwDir = join(tempDir, "Test.framework");
    const versionsDir = join(fwDir, "Versions", "A");
    mkdirSync(versionsDir, { recursive: true });
    writeFileSync(join(versionsDir, "Test"), "binary");

    symlinkSync("A", join(fwDir, "Versions", "Current"));
    symlinkSync("Versions/Current/Test", join(fwDir, "Test"));
    assert.doesNotThrow(() => assertFrameworkSymlinksConfined(fwDir));

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

test("packaging helper verifies app presence and version match across platforms", () => {
  const nonexistent = join(tmpdir(), "Nonexistent.app");
  assert.throws(() => verifyBuiltApp(nonexistent, "0.3.0", "darwin"), /Built application missing/);
  assert.throws(() => verifyBuiltApp(nonexistent, "0.3.0", "win32"), /Built application missing/);
  assert.throws(() => verifyBuiltApp(nonexistent, "0.3.0", "linux"), /Built application missing/);

  // macOS mismatch test
  const mockApp = mkdtempSync(join(tmpdir(), "Mock.app-"));
  const appContents = join(mockApp, "Contents");
  mkdirSync(join(appContents, "MacOS"), { recursive: true });
  try {
    writeFileSync(
      join(appContents, "Info.plist"),
      buildInfoPlist("0.2.0", { suPublicEDKey: VALID_TEST_ED_KEY }),
      "utf8",
    );
    writeFileSync(join(appContents, "MacOS", "Sumi"), "#!/bin/sh\nexit 0\n");

    assert.throws(
      () => verifyBuiltApp(mockApp, "0.3.0", "darwin"),
      /Version mismatch: package\.json specifies 0\.3\.0 but Sumi\.app Info\.plist contains 0\.2\.0/,
    );
  } finally {
    rmSync(mockApp, { recursive: true, force: true });
  }

  // Windows mismatch test
  const mockWinApp = mkdtempSync(join(tmpdir(), "Mock-win-"));
  mkdirSync(join(mockWinApp, "resources"), { recursive: true });
  try {
    writeFileSync(join(mockWinApp, "Sumi.exe"), "dummy");
    writeFileSync(
      join(mockWinApp, "resources", "package.json"),
      JSON.stringify({ version: "0.2.0" }),
      "utf8",
    );
    assert.throws(
      () => verifyBuiltApp(mockWinApp, "0.3.0", "win32"),
      /Version mismatch: package\.json specifies 0\.3\.0 but app resources contains 0\.2\.0/,
    );

    // Update version to match, but add runtime dir missing required CRT DLLs
    writeFileSync(
      join(mockWinApp, "resources", "package.json"),
      JSON.stringify({ version: "0.3.0" }),
      "utf8",
    );
    const winRuntime = join(mockWinApp, "resources", "runtime");
    mkdirSync(winRuntime, { recursive: true });

    // Missing msvcp140.dll must throw
    assert.throws(
      () => verifyBuiltApp(mockWinApp, "0.3.0", "win32"),
      /Required Windows VC\+\+ CRT runtime DLL missing from distribution: msvcp140\.dll/,
    );

    // Provide all 3 required CRT DLLs
    writeFileSync(join(winRuntime, "msvcp140.dll"), "dummy");
    writeFileSync(join(winRuntime, "vcruntime140.dll"), "dummy");
    writeFileSync(join(winRuntime, "vcruntime140_1.dll"), "dummy");

    // Missing app-update.yml must throw
    assert.throws(
      () => verifyBuiltApp(mockWinApp, "0.3.0", "win32"),
      /Required updater configuration missing/,
    );
    writeFileSync(join(mockWinApp, "resources", "app-update.yml"), generateAppUpdateYaml(), "utf8");

    // Verification must now succeed
    const res = verifyBuiltApp(mockWinApp, "0.3.0", "win32");
    assert.equal(res.executable, "Sumi.exe");
    assert.equal(res.version, "0.3.0");
  } finally {
    rmSync(mockWinApp, { recursive: true, force: true });
  }

  // Linux mismatch test
  const mockLinuxApp = mkdtempSync(join(tmpdir(), "Mock-linux-"));
  mkdirSync(join(mockLinuxApp, "resources"), { recursive: true });
  try {
    writeFileSync(join(mockLinuxApp, "sumi"), "dummy");
    writeFileSync(join(mockLinuxApp, "chrome-sandbox"), "dummy");
    writeFileSync(
      join(mockLinuxApp, "resources", "package.json"),
      JSON.stringify({ version: "0.2.0" }),
      "utf8",
    );
    assert.throws(
      () => verifyBuiltApp(mockLinuxApp, "0.3.0", "linux"),
      /Version mismatch: package\.json specifies 0\.3\.0 but app resources contains 0\.2\.0/,
    );

    // Update version to match, but missing app-update.yml must throw
    writeFileSync(
      join(mockLinuxApp, "resources", "package.json"),
      JSON.stringify({ version: "0.3.0" }),
      "utf8",
    );
    assert.throws(
      () => verifyBuiltApp(mockLinuxApp, "0.3.0", "linux"),
      /Required updater configuration missing/,
    );
    writeFileSync(
      join(mockLinuxApp, "resources", "app-update.yml"),
      generateAppUpdateYaml(),
      "utf8",
    );
    const linuxRes = verifyBuiltApp(mockLinuxApp, "0.3.0", "linux");
    assert.equal(linuxRes.executable, "sumi");
    assert.equal(linuxRes.version, "0.3.0");
  } finally {
    rmSync(mockLinuxApp, { recursive: true, force: true });
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
  assert.throws(() => validatePublicEdKey(""), /SUPublicEDKey is required/);
  assert.throws(() => validatePublicEdKey(null), /SUPublicEDKey is required/);
  assert.throws(() => validatePublicEdKey(undefined), /SUPublicEDKey is required/);
  assert.throws(() => validatePublicEdKey("   "), /SUPublicEDKey is required/);
  assert.throws(() => validatePublicEdKey("not base64!"), /SUPublicEDKey must be valid base64/);

  const shortKey = Buffer.from(new Uint8Array(16)).toString("base64");
  assert.throws(() => validatePublicEdKey(shortKey), /must decode to exactly 32 bytes/);
  const longKey = Buffer.from(new Uint8Array(64)).toString("base64");
  assert.throws(() => validatePublicEdKey(longKey), /must decode to exactly 32 bytes/);

  const validKey = Buffer.from(new Uint8Array(32)).toString("base64");
  const result = validatePublicEdKey(validKey);
  assert.equal(result, validKey.trim());

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
  assert.throws(() => validateFeedUrl("http://example.com/appcast.xml"), /must use HTTPS/);
  assert.throws(() => validateFeedUrl(""), /feedUrl is required/);
  assert.throws(() => validateFeedUrl(null), /feedUrl is required/);
  assert.throws(() => validateFeedUrl("not a url"), /must be a valid URL/);
  assert.throws(() => validateFeedUrl("ftp://example.com/appcast.xml"), /must use HTTPS/);
});

test("resolveUpdateConfig throws on empty/invalid publicEdKey and non-HTTPS feed BEFORE any build step", () => {
  const realConfig = JSON.parse(readFileSync(join(root, "desktop/update-config.json"), "utf8"));

  // 1. Explicit deterministic ARM fixture: verifies ARM preserves canonical appcast.xml
  const armProvisioned = resolveUpdateConfig({ config: realConfig, env: {}, arch: "arm64" });
  assert.ok(
    armProvisioned.publicEdKey.length > 0,
    "provisioned config must have a non-empty publicEdKey",
  );
  assert.equal(armProvisioned.publicEdKey, validatePublicEdKey(realConfig.publicEdKey));
  assert.equal(
    armProvisioned.feedUrl,
    "https://github.com/xolah88457/trade-journal/releases/latest/download/appcast.xml",
  );

  // 2. Explicit deterministic Intel fixture: verifies x64 maps canonical feed to appcast-x64.xml
  const x64Provisioned = resolveUpdateConfig({ config: realConfig, env: {}, arch: "x64" });
  assert.equal(x64Provisioned.publicEdKey, validatePublicEdKey(realConfig.publicEdKey));
  assert.equal(
    x64Provisioned.feedUrl,
    "https://github.com/xolah88457/trade-journal/releases/latest/download/appcast-x64.xml",
  );

  // 3. Host architecture resolution: deterministic assertion matching host architecture
  const hostProvisioned = resolveUpdateConfig({ config: realConfig, env: {} });
  const expectedHostFeed =
    process.arch === "x64"
      ? "https://github.com/xolah88457/trade-journal/releases/latest/download/appcast-x64.xml"
      : "https://github.com/xolah88457/trade-journal/releases/latest/download/appcast.xml";
  assert.equal(hostProvisioned.feedUrl, expectedHostFeed);

  assert.throws(
    () => resolveUpdateConfig({ config: { ...realConfig, publicEdKey: "" }, env: {} }),
    /SUPublicEDKey is required/,
  );

  assert.throws(
    () =>
      resolveUpdateConfig({
        config: { feedUrl: "https://example.com/appcast.xml", publicEdKey: "" },
        env: {},
      }),
    /SUPublicEDKey is required/,
  );

  assert.throws(
    () =>
      resolveUpdateConfig({
        config: { feedUrl: "http://example.com/appcast.xml", publicEdKey: VALID_TEST_ED_KEY },
        env: {},
      }),
    /must use HTTPS/,
  );

  assert.throws(
    () =>
      resolveUpdateConfig({
        config: { feedUrl: "https://example.com/appcast.xml", publicEdKey: "not base64!" },
        env: {},
      }),
    /SUPublicEDKey must be valid base64/,
  );

  // Deterministic ARM vs x64 custom feed resolution
  const resolvedArm = resolveUpdateConfig({
    config: { feedUrl: "https://example.com/appcast.xml", publicEdKey: VALID_TEST_ED_KEY },
    env: {},
    arch: "arm64",
  });
  assert.equal(resolvedArm.feedUrl, "https://example.com/appcast.xml");
  assert.equal(resolvedArm.publicEdKey, VALID_TEST_ED_KEY);

  const resolvedX64 = resolveUpdateConfig({
    config: { feedUrl: "https://example.com/appcast.xml", publicEdKey: VALID_TEST_ED_KEY },
    env: {},
    arch: "x64",
  });
  assert.equal(resolvedX64.feedUrl, "https://example.com/appcast-x64.xml");
  assert.equal(resolvedX64.publicEdKey, VALID_TEST_ED_KEY);

  // Env override wins over config on any architecture
  const envResolved = resolveUpdateConfig({
    config: { feedUrl: "https://config.example/appcast.xml", publicEdKey: VALID_TEST_ED_KEY },
    env: {
      SUMI_FEED_URL: "https://env.example/appcast.xml",
      SUMI_PUBLIC_ED_KEY: VALID_TEST_ED_KEY,
    },
    arch: "x64",
  });
  assert.equal(envResolved.feedUrl, "https://env.example/appcast.xml");

  // Default feed without config.feedUrl
  const defaultArmFeed = resolveUpdateConfig({
    config: { publicEdKey: VALID_TEST_ED_KEY },
    env: {},
    arch: "arm64",
  });
  assert.equal(defaultArmFeed.feedUrl, DEFAULT_FEED_URL);

  const defaultX64Feed = resolveUpdateConfig({
    config: { publicEdKey: VALID_TEST_ED_KEY },
    env: {},
    arch: "x64",
  });
  assert.equal(defaultX64Feed.feedUrl, DEFAULT_X64_FEED_URL);
});

test("buildInfoPlist NEVER omits SUPublicEDKey and validates feed + key", () => {
  assert.throws(
    () => buildInfoPlist("0.3.0", { suFeedUrl: DEFAULT_FEED_URL, suPublicEDKey: "" }),
    /SUPublicEDKey is required/,
  );
  assert.throws(() => buildInfoPlist("0.3.0"), /SUPublicEDKey is required/);
  assert.throws(
    () =>
      buildInfoPlist("0.3.0", {
        suFeedUrl: "http://example.com/appcast.xml",
        suPublicEDKey: VALID_TEST_ED_KEY,
      }),
    /must use HTTPS/,
  );

  const xml = buildInfoPlist("0.3.0", {
    suFeedUrl: "https://example.com/appcast.xml",
    suPublicEDKey: VALID_TEST_ED_KEY,
  });
  assert.match(xml, /<key>SUPublicEDKey<\/key>\s*<string>[A-Za-z0-9+/=]+<\/string>/);
  assert.equal(extractPlistValue(xml, "SUPublicEDKey"), VALID_TEST_ED_KEY);
  assert.equal(extractPlistValue(xml, "SUFeedURL"), "https://example.com/appcast.xml");
});

test("bundlePackageWithRuntimeDeps bundles electron-updater production dependency closure without devDependencies", () => {
  const tmp = mkdtempSync(join(tmpdir(), "updater-bundle-test-"));
  const targetNodeModules = join(tmp, "node_modules");
  mkdirSync(targetNodeModules, { recursive: true });

  try {
    bundlePackageWithRuntimeDeps("electron-updater", root, targetNodeModules);

    const bundled = readdirSync(targetNodeModules);
    assert.ok(bundled.includes("electron-updater"), "electron-updater must be bundled");
    assert.ok(bundled.includes("builder-util-runtime"), "builder-util-runtime must be bundled");
    assert.ok(bundled.includes("fs-extra"), "fs-extra must be bundled");
    assert.ok(bundled.includes("semver"), "semver must be bundled");

    // Must NOT bundle build/dev tools
    assert.ok(!bundled.includes("electron-builder"), "electron-builder must NOT be bundled");
    assert.ok(!bundled.includes("typescript"), "typescript must NOT be bundled");
    assert.ok(!bundled.includes("vitest"), "vitest must NOT be bundled");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("release metadata resolves full configuration across macOS, Windows, and Linux", () => {
  // macOS metadata
  const macMeta = getReleaseMetadata(root, "darwin", "arm64");
  assert.equal(macMeta.version, "0.3.0");
  assert.equal(macMeta.platform, "darwin");
  assert.equal(macMeta.arch, "arm64");
  assert.equal(macMeta.zipName, "Sumi-0.3.0-macos-arm64.zip");
  assert.equal(macMeta.dmgName, "Sumi-0.3.0-macos-arm64.dmg");
  assert.ok(typeof macMeta.isBuilt === "boolean");
  assert.ok(typeof macMeta.isPackaged === "boolean");

  // Windows metadata
  const winMeta = getReleaseMetadata(root, "win32", "x64");
  assert.equal(winMeta.version, "0.3.0");
  assert.equal(winMeta.platform, "win32");
  assert.equal(winMeta.arch, "x64");
  assert.equal(winMeta.nsisName, "Sumi-0.3.0-win32-x64-setup.exe");
  assert.equal(winMeta.zipName, "Sumi-0.3.0-win32-x64.zip");
  assert.ok(typeof winMeta.isBuilt === "boolean");
  assert.ok(typeof winMeta.isPackaged === "boolean");

  // Linux metadata
  const linuxMeta = getReleaseMetadata(root, "linux", "x64");
  assert.equal(linuxMeta.version, "0.3.0");
  assert.equal(linuxMeta.platform, "linux");
  assert.equal(linuxMeta.arch, "x64");
  assert.equal(linuxMeta.appImageName, "Sumi-0.3.0-linux-x64.AppImage");
  assert.equal(linuxMeta.debName, "Sumi-0.3.0-linux-x64.deb");
  assert.ok(typeof linuxMeta.isBuilt === "boolean");
  assert.ok(typeof linuxMeta.isPackaged === "boolean");
});

test("REQUIRED_WIN32_CRT_DLLS defines required app-local runtime libraries and resolveWindowsCrtDlls resolves them", () => {
  assert.deepEqual(REQUIRED_WIN32_CRT_DLLS, [
    "msvcp140.dll",
    "vcruntime140.dll",
    "vcruntime140_1.dll",
  ]);

  const mockRedist = mkdtempSync(join(tmpdir(), "vc-redist-mock-"));
  try {
    writeFileSync(join(mockRedist, "msvcp140.dll"), "msvcp");
    writeFileSync(join(mockRedist, "vcruntime140.dll"), "vcruntime");
    writeFileSync(join(mockRedist, "vcruntime140_1.dll"), "vcruntime1");

    const resolved = resolveWindowsCrtDlls({
      env: { VC_REDIST_X64_DIR: mockRedist },
    });
    assert.equal(resolved["msvcp140.dll"], join(mockRedist, "msvcp140.dll"));
    assert.equal(resolved["vcruntime140.dll"], join(mockRedist, "vcruntime140.dll"));
    assert.equal(resolved["vcruntime140_1.dll"], join(mockRedist, "vcruntime140_1.dll"));
  } finally {
    rmSync(mockRedist, { recursive: true, force: true });
  }
});

test("bundlePackageWithRuntimeDeps resolves packages with hidden package.json exports", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "hidden-pkg-fixture-"));
  const fixtureModules = join(fixtureDir, "node_modules");

  try {
    // Package whose exports map hides ./package.json (like koffi/fs-extra variants)
    const hiddenPkgDir = join(fixtureModules, "hidden-lib");
    mkdirSync(join(hiddenPkgDir, "dist"), { recursive: true });
    writeFileSync(
      join(hiddenPkgDir, "package.json"),
      JSON.stringify({
        name: "hidden-lib",
        version: "1.2.3",
        main: "./dist/index.js",
        exports: {
          ".": "./dist/index.js",
        },
      }),
      "utf8",
    );
    writeFileSync(
      join(hiddenPkgDir, "dist", "index.js"),
      "module.exports = { status: 'hidden-pkg-works' };",
      "utf8",
    );

    writeFileSync(
      join(fixtureDir, "package.json"),
      JSON.stringify({
        name: "consumer",
        version: "1.0.0",
        dependencies: { "hidden-lib": "1.2.3" },
      }),
      "utf8",
    );

    // Bundle into isolated target directory
    const isolatedDir = mkdtempSync(join(tmpdir(), "isolated-hidden-"));
    const isolatedModules = join(isolatedDir, "node_modules");
    try {
      bundlePackageWithRuntimeDeps("hidden-lib", fixtureDir, isolatedModules);

      // Verify that require from copied isolated tree succeeds
      const { createRequire } = await import("node:module");
      const isolatedReq = createRequire(join(isolatedDir, "test.js"));
      const loaded = isolatedReq("hidden-lib");
      assert.equal(loaded.status, "hidden-pkg-works");
    } finally {
      rmSync(isolatedDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("bundlePackageWithRuntimeDeps handles two conflicting transitive versions with version-aware nesting", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "conflict-fixture-"));
  const fixtureModules = join(fixtureDir, "node_modules");

  try {
    // pkg-a depends on shared@1.0.0
    mkdirSync(join(fixtureModules, "pkg-a", "node_modules", "shared"), { recursive: true });
    writeFileSync(
      join(fixtureModules, "pkg-a", "package.json"),
      JSON.stringify({
        name: "pkg-a",
        version: "1.0.0",
        main: "index.js",
        dependencies: { shared: "1.0.0" },
      }),
      "utf8",
    );
    writeFileSync(
      join(fixtureModules, "pkg-a", "index.js"),
      "module.exports = { name: 'pkg-a', sharedVersion: require('shared').version };",
      "utf8",
    );
    writeFileSync(
      join(fixtureModules, "pkg-a", "node_modules", "shared", "package.json"),
      JSON.stringify({ name: "shared", version: "1.0.0", main: "index.js" }),
      "utf8",
    );
    writeFileSync(
      join(fixtureModules, "pkg-a", "node_modules", "shared", "index.js"),
      "module.exports = { version: '1.0.0' };",
      "utf8",
    );

    // pkg-b depends on shared@2.0.0
    mkdirSync(join(fixtureModules, "pkg-b", "node_modules", "shared"), { recursive: true });
    writeFileSync(
      join(fixtureModules, "pkg-b", "package.json"),
      JSON.stringify({
        name: "pkg-b",
        version: "1.0.0",
        main: "index.js",
        dependencies: { shared: "2.0.0" },
      }),
      "utf8",
    );
    writeFileSync(
      join(fixtureModules, "pkg-b", "index.js"),
      "module.exports = { name: 'pkg-b', sharedVersion: require('shared').version };",
      "utf8",
    );
    writeFileSync(
      join(fixtureModules, "pkg-b", "node_modules", "shared", "package.json"),
      JSON.stringify({ name: "shared", version: "2.0.0", main: "index.js" }),
      "utf8",
    );
    writeFileSync(
      join(fixtureModules, "pkg-b", "node_modules", "shared", "index.js"),
      "module.exports = { version: '2.0.0' };",
      "utf8",
    );

    writeFileSync(
      join(fixtureDir, "package.json"),
      JSON.stringify({
        name: "root-app",
        version: "1.0.0",
        dependencies: { "pkg-a": "1.0.0", "pkg-b": "1.0.0" },
      }),
      "utf8",
    );

    // Bundle both into isolated directory
    const isolatedDir = mkdtempSync(join(tmpdir(), "isolated-conflict-"));
    const isolatedModules = join(isolatedDir, "node_modules");
    try {
      bundlePackageWithRuntimeDeps("pkg-a", fixtureDir, isolatedModules);
      bundlePackageWithRuntimeDeps("pkg-b", fixtureDir, isolatedModules);

      // Require both from copied isolated tree
      const { createRequire } = await import("node:module");
      const isolatedReq = createRequire(join(isolatedDir, "index.js"));
      const modA = isolatedReq("pkg-a");
      const modB = isolatedReq("pkg-b");

      assert.equal(modA.sharedVersion, "1.0.0", "pkg-a must resolve shared@1.0.0");
      assert.equal(modB.sharedVersion, "2.0.0", "pkg-b must resolve shared@2.0.0");
    } finally {
      rmSync(isolatedDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("bundlePackageWithRuntimeDeps fails loudly when a required dependency is missing", () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "missing-dep-fixture-"));
  try {
    writeFileSync(
      join(fixtureDir, "package.json"),
      JSON.stringify({
        name: "broken-pkg",
        version: "1.0.0",
        dependencies: { "nonexistent-dependency-xyz": "1.0.0" },
      }),
      "utf8",
    );

    const isolatedDir = mkdtempSync(join(tmpdir(), "isolated-missing-"));
    try {
      assert.throws(
        () =>
          bundlePackageWithRuntimeDeps(
            "nonexistent-dependency-xyz",
            fixtureDir,
            join(isolatedDir, "node_modules"),
          ),
        /Required runtime dependency missing: nonexistent-dependency-xyz/,
      );
    } finally {
      rmSync(isolatedDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("augmentStandaloneDependencies guarantees Next-style sibling resolution in dereferenced layouts", async () => {
  const standaloneSrc = join(root, "apps/web/.next/standalone");
  if (!existsSync(standaloneSrc)) return;

  const isolatedServer = mkdtempSync(join(tmpdir(), "standalone-isolated-"));
  try {
    // Copy standalone with dereference (simulating Windows NTFS junction removal)
    cpSync(standaloneSrc, isolatedServer, { recursive: true, dereference: true });

    const webModules = join(isolatedServer, "apps/web/node_modules");
    const { createRequire } = await import("node:module");

    // Before augment: Next fails to resolve sibling styled-jsx/package.json
    const preReqFromNext = createRequire(join(webModules, "next", "package.json"));
    assert.throws(
      () => preReqFromNext.resolve("styled-jsx/package.json"),
      /Cannot find module 'styled-jsx\/package\.json'/,
    );

    // Apply augmentation
    augmentStandaloneDependencies(isolatedServer);

    // After augment: Next successfully resolves sibling styled-jsx and @next/env
    const realIsolated = realpathSync(isolatedServer);
    const postReqFromNext = createRequire(join(webModules, "next", "package.json"));
    const resolvedStyledJsx = postReqFromNext.resolve("styled-jsx/package.json");
    assert.ok(
      resolvedStyledJsx.startsWith(realIsolated),
      "styled-jsx must resolve from within isolated server bundle",
    );

    const resolvedNextEnv = postReqFromNext.resolve("@next/env");
    assert.ok(
      resolvedNextEnv.startsWith(realIsolated),
      "@next/env must resolve from within isolated server bundle",
    );

    // Check that require from server.js entrypoint resolves Next and core runtime dependencies
    const serverReq = createRequire(join(isolatedServer, "apps/web/server.js"));
    assert.doesNotThrow(() => serverReq.resolve("next"));
    assert.doesNotThrow(() => serverReq.resolve("better-sqlite3"));
    assert.doesNotThrow(() => serverReq.resolve("react"));
  } finally {
    rmSync(isolatedServer, { recursive: true, force: true });
  }
});

test("electron-builder publish config targets canonical fork repository and never-publish on-tag", () => {
  assert.deepEqual(GITHUB_PUBLISH_CONFIG, [
    {
      provider: "github",
      owner: "xolah88457",
      repo: "trade-journal",
    },
  ]);
  assert.equal(DEBIAN_MAINTAINER, "Sumi contributors <noreply@github.com>");
});

test("mergeLinuxYml preserves both AppImage and Deb metadata entries in latest-linux.yml", async () => {
  const appImageYaml = `
version: 0.3.0
files:
  - url: Sumi-0.3.0-linux-x64.AppImage
    sha512: appimage_sha512_hash_value_12345
    size: 104857600
path: Sumi-0.3.0-linux-x64.AppImage
sha512: appimage_sha512_hash_value_12345
releaseDate: 2026-11-07T16:00:00.000Z
`;

  const debYaml = `
version: 0.3.0
files:
  - url: Sumi-0.3.0-linux-x64.deb
    sha512: deb_sha512_hash_value_67890
    size: 83886080
path: Sumi-0.3.0-linux-x64.deb
sha512: deb_sha512_hash_value_67890
releaseDate: 2026-11-07T16:00:00.000Z
`;

  const mergedText = mergeLinuxYml(appImageYaml, debYaml);
  const { createRequire } = await import("node:module");
  const req = createRequire(import.meta.url);
  const yaml = req(req.resolve("electron-updater")).load
    ? req("electron-updater")
    : createRequire(req.resolve("electron-updater"))("js-yaml");

  const parsed = yaml.load(mergedText);
  assert.equal(parsed.version, "0.3.0");
  assert.equal(parsed.path, "Sumi-0.3.0-linux-x64.AppImage");
  assert.equal(parsed.files.length, 2);

  const urls = parsed.files.map((f) => f.url);
  assert.ok(
    urls.includes("Sumi-0.3.0-linux-x64.AppImage"),
    "Merged YAML must contain AppImage entry",
  );
  assert.ok(urls.includes("Sumi-0.3.0-linux-x64.deb"), "Merged YAML must contain deb entry");

  const appImageEntry = parsed.files.find((f) => f.url === "Sumi-0.3.0-linux-x64.AppImage");
  assert.equal(appImageEntry.sha512, "appimage_sha512_hash_value_12345");

  const debEntry = parsed.files.find((f) => f.url === "Sumi-0.3.0-linux-x64.deb");
  assert.equal(debEntry.sha512, "deb_sha512_hash_value_67890");
});

test("packageApp with customBuilder validates Windows builder options, artifactName overrides, and publish never", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "win-pkg-test-"));
  const appPath = join(tempDir, "sumi-win32-x64");
  const distDir = join(tempDir, "dist");
  mkdirSync(join(appPath, "resources", "runtime"), { recursive: true });
  mkdirSync(distDir, { recursive: true });

  try {
    writeFileSync(join(appPath, "Sumi.exe"), "dummy exe");
    writeFileSync(
      join(appPath, "resources", "package.json"),
      JSON.stringify({ version: "0.3.0" }),
      "utf8",
    );
    writeFileSync(join(appPath, "resources", "runtime", "msvcp140.dll"), "dll");
    writeFileSync(join(appPath, "resources", "runtime", "vcruntime140.dll"), "dll");
    writeFileSync(join(appPath, "resources", "runtime", "vcruntime140_1.dll"), "dll");
    writeFileSync(join(appPath, "resources", "app-update.yml"), generateAppUpdateYaml(), "utf8");

    const builderCalls = [];
    const customBuilder = async (opts) => {
      builderCalls.push(opts);
      // Simulate builder writing expected artifacts
      writeFileSync(join(distDir, "Sumi-0.3.0-win32-x64-setup.exe"), "dummy nsis");
      writeFileSync(join(distDir, "Sumi-0.3.0-win32-x64.zip"), "dummy zip");
    };

    const res = await packageApp({
      platform: "win32",
      arch: "x64",
      version: "0.3.0",
      appPath,
      distDir,
      customBuilder,
    });

    assert.equal(builderCalls.length, 1);
    const call = builderCalls[0];
    assert.equal(call.publish, "never", "Builder must explicitly specify publish: 'never'");
    assert.deepEqual(call.config.publish, GITHUB_PUBLISH_CONFIG);
    assert.equal(call.config.npmRebuild, false);
    assert.equal(call.config.win.artifactName, "Sumi-0.3.0-win32-x64.zip");
    assert.equal(call.config.nsis.artifactName, "Sumi-0.3.0-win32-x64-setup.exe");

    assert.equal(res.artifacts.length, 2);
    assert.ok(existsSync(join(distDir, "SHA256SUMS.txt")));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("packageApp with customBuilder validates Linux builder options, debian maintainer, package-type staging, and metadata merge", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "linux-pkg-test-"));
  const appPath = join(tempDir, "sumi-linux-x64");
  const distDir = join(tempDir, "dist");
  mkdirSync(join(appPath, "resources"), { recursive: true });
  mkdirSync(distDir, { recursive: true });

  try {
    writeFileSync(join(appPath, "sumi"), "dummy binary");
    writeFileSync(join(appPath, "chrome-sandbox"), "dummy sandbox");
    writeFileSync(
      join(appPath, "resources", "package.json"),
      JSON.stringify({ version: "0.3.0" }),
      "utf8",
    );
    writeFileSync(join(appPath, "resources", "app-update.yml"), generateAppUpdateYaml(), "utf8");

    const builderCalls = [];
    const customBuilder = async (opts) => {
      const packageTypeExists = existsSync(join(appPath, "resources", "package-type"));
      const packageTypeContent = packageTypeExists
        ? readFileSync(join(appPath, "resources", "package-type"), "utf8")
        : null;

      builderCalls.push({
        opts,
        packageTypeExists,
        packageTypeContent,
      });

      if (opts.config.appImage) {
        writeFileSync(join(distDir, "Sumi-0.3.0-linux-x64.AppImage"), "dummy appimage");
        writeFileSync(
          join(distDir, "latest-linux.yml"),
          "version: 0.3.0\nfiles:\n  - url: Sumi-0.3.0-linux-x64.AppImage\n    sha512: fake_ai_sha512\n    size: 100\npath: Sumi-0.3.0-linux-x64.AppImage\nsha512: fake_ai_sha512\n",
          "utf8",
        );
      } else if (opts.config.deb) {
        writeFileSync(join(distDir, "Sumi-0.3.0-linux-x64.deb"), "dummy deb");
        writeFileSync(
          join(distDir, "latest-linux.yml"),
          "version: 0.3.0\nfiles:\n  - url: Sumi-0.3.0-linux-x64.deb\n    sha512: fake_deb_sha512\n    size: 80\npath: Sumi-0.3.0-linux-x64.deb\nsha512: fake_deb_sha512\n",
          "utf8",
        );
      }
    };

    const res = await packageApp({
      platform: "linux",
      arch: "x64",
      version: "0.3.0",
      appPath,
      distDir,
      customBuilder,
    });

    assert.equal(builderCalls.length, 2);

    // Call 1: AppImage
    const call1 = builderCalls[0];
    assert.equal(call1.opts.publish, "never");
    assert.deepEqual(call1.opts.config.publish, GITHUB_PUBLISH_CONFIG);
    assert.equal(
      call1.packageTypeExists,
      false,
      "package-type must NOT exist during AppImage build",
    );
    assert.equal(call1.opts.config.appImage.artifactName, "Sumi-0.3.0-linux-x64.AppImage");

    // Call 2: deb
    const call2 = builderCalls[1];
    assert.equal(call2.opts.publish, "never");
    assert.equal(call2.packageTypeExists, true, "package-type must exist during deb build");
    assert.equal(call2.packageTypeContent, "deb\n");
    assert.equal(call2.opts.config.deb.artifactName, "Sumi-0.3.0-linux-x64.deb");
    assert.equal(call2.opts.config.linux.maintainer, DEBIAN_MAINTAINER);
    assert.equal(
      call2.opts.config.deb.depends,
      undefined,
      "Debian depends must NOT be truncated to 3 libraries",
    );

    // After build: package-type must be cleaned up from staged app
    assert.equal(existsSync(join(appPath, "resources", "package-type")), false);

    // Check merged latest-linux.yml
    const mergedYml = readFileSync(join(distDir, "latest-linux.yml"), "utf8");
    assert.ok(mergedYml.includes("Sumi-0.3.0-linux-x64.AppImage"));
    assert.ok(mergedYml.includes("Sumi-0.3.0-linux-x64.deb"));

    assert.equal(res.artifacts.length, 2);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Source Node copied isolated application module load test asserts platform adapter loads without Electron/network", async () => {
  const isolatedApp = mkdtempSync(join(tmpdir(), "sumi-isolated-app-"));
  const appNodeModules = join(isolatedApp, "node_modules");
  mkdirSync(appNodeModules, { recursive: true });

  try {
    // 1. Copy all REQUIRED_DESKTOP_SCRIPTS into isolated app
    for (const script of REQUIRED_DESKTOP_SCRIPTS) {
      const src = join(root, "desktop", script);
      assert.ok(existsSync(src), `Required script must exist at ${src}`);
      cpSync(src, join(isolatedApp, script));
    }

    // 2. Bundle electron-updater runtime dependency closure into app/node_modules
    bundlePackageWithRuntimeDeps("electron-updater", root, appNodeModules);

    // 3. Write package.json in isolated app
    writeFileSync(
      join(isolatedApp, "package.json"),
      JSON.stringify({
        name: "sumi-desktop",
        version: "0.3.0",
        type: "commonjs",
      }),
      "utf8",
    );

    // 4. Require update-service-platform.cjs from the copied isolated tree in pure Node
    const { createRequire } = await import("node:module");
    const isolatedReq = createRequire(join(isolatedApp, "index.js"));

    const platformAdapter = isolatedReq("./update-service-platform.cjs");
    assert.ok(platformAdapter, "Platform adapter module must load in isolated tree");
    assert.equal(typeof platformAdapter.isPlatformUpdatable, "function");
    assert.equal(typeof platformAdapter.createElectronUpdaterService, "function");

    // Test platform updatability detection without actual system changes
    const winCheck = platformAdapter.isPlatformUpdatable({ platform: "win32" });
    assert.equal(winCheck.updatable, true);
    assert.equal(winCheck.provider, "electron-updater");
    assert.equal(winCheck.packageType, "nsis");

    const appImageCheck = platformAdapter.isPlatformUpdatable({
      platform: "linux",
      env: { APPIMAGE: "/opt/sumi/Sumi.AppImage" },
    });
    assert.equal(appImageCheck.updatable, true);
    assert.equal(appImageCheck.packageType, "appimage");

    const portableCheck = platformAdapter.isPlatformUpdatable({
      platform: "linux",
      env: {},
      resourcesPath: isolatedApp,
    });
    assert.equal(portableCheck.updatable, false);
    assert.equal(portableCheck.packageType, "portable");

    // Test service instantiation and state inspection without network/Electron
    const service = platformAdapter.createElectronUpdaterService({
      app: {
        getVersion: () => "0.3.0",
      },
    });

    const state = service.getState();
    assert.equal(state.status, "idle");
    assert.equal(state.currentVersion, "0.3.0");
    assert.equal(state.availableVersion, null);
    assert.equal(state.error, null);

    // Dispose resets state cleanly
    service.dispose();
    assert.equal(service.getState().status, "idle");
  } finally {
    rmSync(isolatedApp, { recursive: true, force: true });
  }
});

test("getPnpmCommand dispatches platform-safe invocation across Windows and Unix", () => {
  // Unix dispatch
  const unixDispatch = getPnpmCommand(["build"], {}, "darwin");
  assert.equal(unixDispatch.command, "pnpm");
  assert.deepEqual(unixDispatch.args, ["build"]);

  const linuxDispatch = getPnpmCommand(["build"], {}, "linux");
  assert.equal(linuxDispatch.command, "pnpm");
  assert.deepEqual(linuxDispatch.args, ["build"]);

  // Windows ComSpec fallback (cmd.exe /d /s /c "pnpm build")
  const winDispatch = getPnpmCommand(
    ["build"],
    { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    "win32",
  );
  assert.equal(winDispatch.command, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(winDispatch.args, ["/d", "/s", "/c", "pnpm build"]);
  assert.equal(winDispatch.options.windowsVerbatimArguments, true);

  // Windows with default COMSPEC
  const winDefault = getPnpmCommand(["build", "--filter", "web"], {}, "win32");
  assert.equal(winDefault.command, "cmd.exe");
  assert.deepEqual(winDefault.args, ["/d", "/s", "/c", "pnpm build --filter web"]);

  // Validated npm_execpath points to JS script: runs directly via Node binary on any platform
  const tmpScript = mkdtempSync(join(tmpdir(), "pnpm-script-"));
  const fakePnpmJs = join(tmpScript, "pnpm.cjs");
  try {
    writeFileSync(fakePnpmJs, "");
    const nodeDispatch = getPnpmCommand(["build"], { npm_execpath: fakePnpmJs }, "win32");
    assert.equal(nodeDispatch.command, process.execPath);
    assert.deepEqual(nodeDispatch.args, [fakePnpmJs, "build"]);
  } finally {
    rmSync(tmpScript, { recursive: true, force: true });
  }
});

test("canonical resources/app-update.yml is staged on non-Mac with fork coordinates and updaterCacheDirName", async () => {
  assert.equal(APP_UPDATE_CONFIG.owner, "xolah88457");
  assert.equal(APP_UPDATE_CONFIG.repo, "trade-journal");
  assert.equal(APP_UPDATE_CONFIG.provider, "github");
  assert.equal(APP_UPDATE_CONFIG.updaterCacheDirName, "sumi-updater");

  const yamlContent = generateAppUpdateYaml();
  assert.match(yamlContent, /^owner:\s*xolah88457$/m);
  assert.match(yamlContent, /^repo:\s*trade-journal$/m);
  assert.match(yamlContent, /^provider:\s*github$/m);
  assert.match(yamlContent, /^updaterCacheDirName:\s*sumi-updater$/m);

  // Must not reference upstream LuxAlgo or contain secrets/tokens
  assert.doesNotMatch(yamlContent, /luxalgo/i);
  assert.doesNotMatch(yamlContent, /token/i);
  assert.doesNotMatch(yamlContent, /secret/i);
  assert.doesNotMatch(yamlContent, /key/i);

  // Parse with js-yaml to verify standard format
  const { createRequire } = await import("node:module");
  const req = createRequire(import.meta.url);
  const yaml = createRequire(req.resolve("electron-updater"))("js-yaml");
  const parsed = yaml.load(yamlContent);
  assert.equal(parsed.owner, "xolah88457");
  assert.equal(parsed.repo, "trade-journal");
  assert.equal(parsed.provider, "github");
  assert.equal(parsed.updaterCacheDirName, "sumi-updater");
});

test("isPathContained checks cross-platform confinement, handles Windows backslashes, and rejects UNC and cross-drive escapes", () => {
  // Unix boundaries
  assert.equal(isPathContained("/app/base", "/app/base/sub/file", "darwin"), true);
  assert.equal(isPathContained("/app/base", "/app/base", "darwin"), true);
  assert.equal(isPathContained("/app/base", "/app/outside", "darwin"), false);
  assert.equal(isPathContained("/app/base", "/app/base/../outside", "darwin"), false);

  // Linux boundaries
  assert.equal(isPathContained("/opt/sumi", "/opt/sumi/resources/app", "linux"), true);
  assert.equal(isPathContained("/opt/sumi", "/etc/passwd", "linux"), false);

  // Windows backslash and case-insensitivity
  assert.equal(
    isPathContained("C:\\bundle", "C:\\bundle\\Versions\\A\\Test", "win32"),
    true,
    "Valid Windows child path with backslashes must be contained",
  );
  assert.equal(
    isPathContained("C:\\bundle", "c:\\bundle\\sub\\file", "win32"),
    true,
    "Windows case differences must be recognized as contained",
  );
  assert.equal(isPathContained("C:\\bundle", "C:\\bundle", "win32"), true);

  // Windows escaping paths
  assert.equal(
    isPathContained("C:\\bundle", "C:\\outside\\file", "win32"),
    false,
    "Sibling outside path must escape",
  );
  assert.equal(
    isPathContained("C:\\bundle", "C:\\bundle\\..\\outside", "win32"),
    false,
    "Parent traversal must escape",
  );

  // Windows cross-drive and UNC paths
  assert.equal(
    isPathContained("C:\\bundle", "D:\\bundle\\file", "win32"),
    false,
    "Cross-drive path must escape",
  );
  assert.equal(
    isPathContained("C:\\bundle", "\\\\server\\share\\file", "win32"),
    false,
    "UNC path must escape",
  );
});

test("resolveKoffiPackageDir and assertKoffiPayload verify complete native binary payload", () => {
  const pkgDir = resolveKoffiPackageDir(root, process.platform, process.arch);
  assert.ok(pkgDir, "Koffi package directory must resolve on host");
  assert.ok(
    existsSync(join(pkgDir, "package.json")),
    "package.json must exist in Koffi package dir",
  );
  assert.ok(existsSync(join(pkgDir, "index.js")), "index.js must exist in Koffi package dir");

  const normArch = process.arch === "arm64" ? "arm64" : "x64";
  const binarySubpath = `${process.platform}_${normArch}/koffi.node`;
  assert.ok(
    existsSync(join(pkgDir, binarySubpath)),
    `Native binary payload must exist at ${join(pkgDir, binarySubpath)}`,
  );

  // Test assertKoffiPayload with mock directory
  const mockServer = mkdtempSync(join(tmpdir(), "mock-server-koffi-"));
  try {
    // Missing payload throws
    assert.throws(
      () => assertKoffiPayload(mockServer, process.platform, process.arch),
      /Koffi native binary payload missing/,
    );

    // Provide payload
    const pkgDest = join(
      mockServer,
      "node_modules",
      `@koromix/koffi-${process.platform}-${normArch}`,
    );
    mkdirSync(join(pkgDest, `${process.platform}_${normArch}`), { recursive: true });
    writeFileSync(join(pkgDest, binarySubpath), "dummy node binary");

    // Assertion succeeds
    const found = assertKoffiPayload(mockServer, process.platform, process.arch);
    assert.ok(found.length > 0);
  } finally {
    rmSync(mockServer, { recursive: true, force: true });
  }
});
