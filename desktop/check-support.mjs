import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Expected Silero VAD asset metadata.
 * Only this small ~1.2 MB asset is permitted inside the application bundle.
 * Heavy ASR weights (such as Parakeet ~731 MB) must strictly reside outside the bundle.
 */
export const SILERO_EXPECTED_SIZE = 1241056;
export const SILERO_EXPECTED_SHA256 =
  "0d871a800c420fdd5d1b17a3aea4296d1c39608f0ff4a9295eb76457eb1c88e6";

export const EXPECTED_BUNDLE_ID = "local.sumi.journal";
export const EXPECTED_ELECTRON_VERSION = "45.2.3";

/**
 * Recursively asserts that no private environment credentials, database files,
 * forbidden heavy model weights, or secret files exist in the bundled directory.
 */
export function checkNoPrivateFiles(directory) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    assert.ok(!entry.name.startsWith(".env"), `Environment file bundled: ${entry.name}`);
    assert.ok(
      !/\.(db|sqlite)(-shm|-wal|-journal)?$/.test(entry.name),
      `Database bundled: ${entry.name}`,
    );
    if (entry.name.endsWith(".gguf")) {
      assert.equal(
        entry.name,
        "silero-vad-v6.2-F32.gguf",
        `Only Silero VAD is allowed in the application bundle; found unexpected model: ${entry.name}`,
      );
    }
    assert.notEqual(entry.name, ".secret", `Secret file bundled: ${entry.name}`);
    const path = join(directory, entry.name);
    if (entry.isDirectory()) checkNoPrivateFiles(path);
  }
}

/**
 * Recursively asserts that every symbolic link resolves strictly within basePrefix.
 */
export function checkSelfContainedSymlinks(directory, basePrefix) {
  if (!existsSync(directory)) return;
  const canonicalPrefix = realpathSync(basePrefix.replace(/\/$/, "")) + "/";
  const canonicalBase = canonicalPrefix.slice(0, -1);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const real = realpathSync(path);
      assert.ok(
        real === canonicalBase || real.startsWith(canonicalPrefix),
        `Symlink escapes application bundle into developer checkout: ${path} -> ${real}`,
      );
    } else if (entry.isDirectory()) {
      checkSelfContainedSymlinks(path, canonicalPrefix);
    }
  }
}

/**
 * Finds a valid license or notice file from a list of candidate paths.
 */
export function findLicenseFile(candidatePaths, description) {
  for (const p of candidatePaths) {
    if (existsSync(p)) {
      const text = readFileSync(p, "utf8");
      if (text.trim().length > 100) return p;
    }
  }
  throw new Error(
    `${description} missing or too short from bundle candidates: ${candidatePaths.join(", ")}`,
  );
}

/**
 * Bounded output limit for small text emitted by Mach-O tools (otool/lipo/file).
 * NEVER pipe multi-hundred-MB binaries through `strings` - that is what caused
 * spawnSync ENOBUFS on the ~200MB Electron Framework binary.
 */
export const TOOL_OUTPUT_MAX_BUFFER = 1024 * 1024; // 1MB, plenty for tool text output

/**
 * Extracts a <string> value for a key from plist XML content. Returns null if absent.
 */
export function extractPlistString(plistContent, key) {
  const match = plistContent.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`));
  return match ? match[1] : null;
}

/**
 * Verifies the Electron Framework structure, Mach-O link dependencies,
 * architecture, and Electron 45.2.3 vendor version - using ONLY bounded
 * checks: small Info.plist metadata read, otool -L, lipo -info, file.
 * `runTool` is injectable for synthetic unit tests (defaults to execFileSync).
 */
export function verifyElectronFramework(appDir, runTool = execFileSync) {
  const fwPath = join(appDir, "Frameworks/Electron Framework.framework");
  assert.ok(existsSync(fwPath), `Electron Framework missing at ${fwPath}`);

  const executable = join(appDir, "MacOS/Sumi");
  assert.ok(existsSync(executable), `App binary missing at ${executable}`);

  // Bounded Mach-O link check on the small app executable
  const linked = runTool("otool", ["-L", executable], {
    encoding: "utf8",
    maxBuffer: TOOL_OUTPUT_MAX_BUFFER,
  });
  assert.match(
    linked,
    /Electron Framework/,
    "Sumi executable must link against Electron Framework",
  );
  assert.doesNotMatch(
    linked,
    /libswiftCore/,
    "Executable must be Electron, not the legacy Swift wrapper",
  );

  if (process.platform === "darwin" && process.arch === "arm64") {
    const fileOutput = runTool("file", [executable], {
      encoding: "utf8",
      maxBuffer: TOOL_OUTPUT_MAX_BUFFER,
    });
    assert.match(fileOutput, /arm64/, "Mach-O executable must support arm64 architecture");

    // Bounded architecture check on the framework binary itself (lipo prints
    // one short line - never scan the binary with `strings`)
    const fwBinaryCandidates = [
      join(fwPath, "Versions/Current/Electron Framework"),
      join(fwPath, "Versions/A/Electron Framework"),
      join(fwPath, "Electron Framework"),
    ];
    const fwBinary = fwBinaryCandidates.find((p) => existsSync(p));
    if (fwBinary) {
      const lipoOutput = runTool("lipo", ["-info", fwBinary], {
        encoding: "utf8",
        maxBuffer: TOOL_OUTPUT_MAX_BUFFER,
      });
      assert.match(
        lipoOutput,
        /arm64/,
        "Electron Framework binary must be an arm64 Mach-O (lipo -info)",
      );
    }
  }

  // Bounded vendor version check: the framework Info.plist is a small XML file.
  // BOTH CFBundleShortVersionString and CFBundleVersion must pin Electron 45.2.3
  // (the build stamps the pinned ELECTRON_VERSION, not the root app version).
  const fwPlistCandidates = [
    join(fwPath, "Resources/Info.plist"),
    join(fwPath, "Versions/Current/Resources/Info.plist"),
    join(fwPath, "Versions/A/Resources/Info.plist"),
    join(fwPath, "Info.plist"),
  ];
  const fwPlist = fwPlistCandidates.find((p) => existsSync(p));
  assert.ok(fwPlist, `Electron Framework Info.plist missing at ${fwPlistCandidates.join(", ")}`);
  const plistStat = statSyncSafe(fwPlist);
  assert.ok(
    plistStat.size <= TOOL_OUTPUT_MAX_BUFFER,
    `Framework Info.plist unexpectedly large (${plistStat.size} bytes) - refusing unbounded read`,
  );
  const plistContent = readFileSync(fwPlist, "utf8");
  const shortVersion = extractPlistString(plistContent, "CFBundleShortVersionString");
  const buildVersion = extractPlistString(plistContent, "CFBundleVersion");
  assert.equal(
    shortVersion,
    EXPECTED_ELECTRON_VERSION,
    `Electron Framework CFBundleShortVersionString must be ${EXPECTED_ELECTRON_VERSION}, got ${shortVersion}`,
  );
  assert.equal(
    buildVersion,
    EXPECTED_ELECTRON_VERSION,
    `Electron Framework CFBundleVersion must be ${EXPECTED_ELECTRON_VERSION}, got ${buildVersion}`,
  );
}

function statSyncSafe(p) {
  try {
    return statSync(p);
  } catch {
    return { size: 0 };
  }
}

/**
 * Validates Info.plist contents: bundle ID, microphone usage, version, minimum macOS 13+.
 */
export function validateInfoPlistContent(plistContent, expectedVersion) {
  assert.match(
    plistContent,
    /<key>CFBundleIconFile<\/key>\s*<string>Sumi(\.icns)?<\/string>/,
    "Info.plist must specify Sumi icon",
  );
  assert.match(
    plistContent,
    new RegExp(
      `<key>CFBundleIdentifier<\\/key>\\s*<string>${EXPECTED_BUNDLE_ID.replaceAll(".", "\\.")}<\\/string>`,
    ),
    `Info.plist CFBundleIdentifier must be ${EXPECTED_BUNDLE_ID}`,
  );
  assert.match(
    plistContent,
    /<key>NSMicrophoneUsageDescription<\/key>\s*<string>[^<]+<\/string>/,
    "Info.plist must contain non-empty NSMicrophoneUsageDescription",
  );
  const versionRegex = new RegExp(
    `<key>CFBundleShortVersionString<\\/key>\\s*<string>${expectedVersion.replaceAll(".", "\\.")}<\\/string>`,
  );
  assert.match(
    plistContent,
    versionRegex,
    `Info.plist CFBundleShortVersionString must match ${expectedVersion}`,
  );

  const minSysMatch = plistContent.match(
    /<key>LSMinimumSystemVersion<\/key>\s*<string>([^<]+)<\/string>/,
  );
  assert.ok(minSysMatch, "Info.plist must specify LSMinimumSystemVersion");
  const major = parseFloat(minSysMatch[1]);
  assert.ok(major >= 14.0, `LSMinimumSystemVersion must be >= 14.0, found ${minSysMatch[1]}`);
}

/**
 * Validates Resources/app/package.json and shell cjs files.
 */
export function verifyAppPackage(resourcesDir, expectedVersion) {
  const appDir = join(resourcesDir, "app");
  assert.ok(existsSync(appDir), "Resources/app directory missing");

  const pkgPath = join(appDir, "package.json");
  assert.ok(existsSync(pkgPath), "Resources/app/package.json missing");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  assert.equal(pkg.main, "main.cjs", "Resources/app/package.json main must be main.cjs");
  assert.equal(
    pkg.version,
    expectedVersion,
    `Resources/app/package.json version (${pkg.version}) must match root version (${expectedVersion})`,
  );

  // Shell entrypoints and security modules
  for (const file of ["main.cjs", "preload.cjs", "preferences.cjs", "security.cjs"]) {
    const filePath = join(appDir, file);
    assert.ok(existsSync(filePath), `Required shell file missing: Resources/app/${file}`);
  }

  // If update-service.cjs is packaged, verify it is non-empty
  const updateService = join(appDir, "update-service.cjs");
  if (existsSync(updateService)) {
    assert.ok(
      readFileSync(updateService, "utf8").trim().length > 0,
      "Resources/app/update-service.cjs must not be empty",
    );
  }
}

/**
 * Validates licenses: flat licenses (Trade-Journal, Kami, Node, Silero),
 * Electron LICENSE, and Chromium third-party notices.
 */
export function verifyLicenses(resourcesDir, appDir) {
  const licensesDir = join(resourcesDir, "licenses");
  assert.ok(existsSync(licensesDir), "Resources/licenses directory missing");

  for (const file of [
    "Trade-Journal-MIT.txt",
    "Kami-MIT.txt",
    "Node-LICENSE.txt",
    "Silero-VAD-MIT.txt",
  ]) {
    const licPath = join(licensesDir, file);
    assert.ok(existsSync(licPath), `Upstream license missing: ${file}`);
    assert.ok(readFileSync(licPath, "utf8").length > 100, `License ${file} is too short`);
  }

  // Electron LICENSE must exist
  findLicenseFile(
    [
      join(licensesDir, "Electron-LICENSE.txt"),
      join(licensesDir, "LICENSE.electron.txt"),
      join(licensesDir, "Electron-LICENSE"),
      join(resourcesDir, "Electron-LICENSE.txt"),
      join(resourcesDir, "LICENSE"),
      join(appDir, "Frameworks/Electron Framework.framework/Resources/LICENSE"),
      join(appDir, "Frameworks/Electron Framework.framework/LICENSE"),
    ],
    "Electron LICENSE",
  );

  // Chromium third-party notices must exist
  findLicenseFile(
    [
      join(licensesDir, "LICENSES.chromium.html"),
      join(licensesDir, "Chromium-LICENSES.html"),
      join(licensesDir, "THIRD-PARTY-NOTICES.md"),
      join(resourcesDir, "LICENSES.chromium.html"),
      join(appDir, "Frameworks/Electron Framework.framework/Resources/LICENSES.chromium.html"),
      join(appDir, "Frameworks/Electron Framework.framework/Libraries/LICENSES.chromium.html"),
    ],
    "Chromium third-party notices",
  );
}

/**
 * Validates Silero VAD asset exact size and SHA-256 checksum,
 * and asserts heavy Parakeet ASR weights are excluded.
 */
export function verifySileroModel(webDir) {
  const bundledSilero = join(webDir, "models/silero-vad-v6.2-F32.gguf");
  assert.ok(existsSync(bundledSilero), `Bundled Silero VAD model missing at ${bundledSilero}`);
  const sileroBytes = readFileSync(bundledSilero);
  assert.equal(sileroBytes.length, SILERO_EXPECTED_SIZE, "Bundled Silero VAD size mismatch");
  const sileroHash = createHash("sha256").update(sileroBytes).digest("hex");
  assert.equal(sileroHash, SILERO_EXPECTED_SHA256, "Bundled Silero VAD checksum mismatch");

  assert.ok(
    !existsSync(join(webDir, "models/parakeet-unified-en-0.6b-Q8_0.gguf")),
    "Parakeet ASR weights must never be bundled inside .app",
  );
}

/**
 * Comprehensive verification for the complete packaged Electron bundle.
 */
export function verifyElectronPackage({ app, resources, root }) {
  assert.ok(existsSync(join(app, "MacOS/Sumi")), "Run pnpm desktop:build first.");
  assert.ok(existsSync(join(resources, "Sumi.icns")), "Application icon Sumi.icns missing.");

  // Electron framework requirements & Mach-O verification
  verifyElectronFramework(app);

  // Info.plist validation
  execFileSync("plutil", ["-lint", join(app, "Info.plist")]);
  const plistContent = readFileSync(join(app, "Info.plist"), "utf8");
  const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const expectedVersion = rootPkg.version || "0.2.0";
  validateInfoPlistContent(plistContent, expectedVersion);

  // Codesign verification (deep, strict, works ad-hoc)
  execFileSync("codesign", ["--verify", "--deep", "--strict", join(app, "..")]);

  // Portable Node runtime check (must not link homebrew or macports)
  const node = join(resources, "runtime/node");
  assert.ok(existsSync(node), "Bundled node binary missing");
  const linkedNode = execFileSync("otool", ["-L", node], { encoding: "utf8" });
  assert.doesNotMatch(linkedNode, /\/opt\/homebrew|\/usr\/local\/opt/);

  // Transcribe-cpp darwin-arm64-metal library check
  if (process.platform === "darwin" && process.arch === "arm64") {
    const nativeLibPath = join(
      resources,
      "server/node_modules/@transcribe-cpp/darwin-arm64-metal/libtranscribe.dylib",
    );
    const altLibPath = join(
      resources,
      "server/apps/web/node_modules/@transcribe-cpp/darwin-arm64-metal/libtranscribe.dylib",
    );
    assert.ok(
      existsSync(nativeLibPath) || existsSync(altLibPath),
      "Native transcribe-cpp library (libtranscribe.dylib) missing from bundled app",
    );
  }

  // Shell code files and Resources/app/package.json
  verifyAppPackage(resources, expectedVersion);

  // Licenses check
  verifyLicenses(resources, app);

  // Silero VAD asset and ASR Parakeet exclusions
  verifySileroModel(join(resources, "server/apps/web"));

  // Check no private files across server and app
  checkNoPrivateFiles(join(resources, "server"));
  checkNoPrivateFiles(join(resources, "app"));

  // Symlink confinement to app bundle
  const appPrefix = realpathSync(join(app, "..")) + "/";
  checkSelfContainedSymlinks(resources, appPrefix);
  const serverReal = realpathSync(join(resources, "server")) + "/";
  checkSelfContainedSymlinks(join(resources, "server"), serverReal);
}

// Self-contained unit helper tests for check-support validation functions
export function runUnitTests() {
  const tempDir = mkdtempSync(join(tmpdir(), "check-support-unit-"));
  try {
    // 1. Test checkNoPrivateFiles
    const cleanDir = join(tempDir, "clean");
    mkdirSync(cleanDir, { recursive: true });
    writeFileSync(join(cleanDir, "silero-vad-v6.2-F32.gguf"), "model");
    writeFileSync(join(cleanDir, "index.js"), "code");
    checkNoPrivateFiles(cleanDir);

    const envDir = join(tempDir, "env");
    mkdirSync(envDir, { recursive: true });
    writeFileSync(join(envDir, ".env.production"), "SECRET=1");
    assert.throws(() => checkNoPrivateFiles(envDir), /Environment file bundled/);

    const dbDir = join(tempDir, "db");
    mkdirSync(dbDir, { recursive: true });
    writeFileSync(join(dbDir, "journal.db"), "data");
    assert.throws(() => checkNoPrivateFiles(dbDir), /Database bundled/);

    const badGguf = join(tempDir, "gguf");
    mkdirSync(badGguf, { recursive: true });
    writeFileSync(join(badGguf, "parakeet.gguf"), "heavy");
    assert.throws(() => checkNoPrivateFiles(badGguf), /Only Silero VAD is allowed/);

    // 2. Test checkSelfContainedSymlinks
    const linkBase = join(tempDir, "bundle");
    mkdirSync(join(linkBase, "sub"), { recursive: true });
    writeFileSync(join(linkBase, "sub/target.txt"), "hello");
    symlinkSync(join(linkBase, "sub/target.txt"), join(linkBase, "valid-link.txt"));
    checkSelfContainedSymlinks(linkBase, linkBase + "/");

    const outsideTarget = join(tempDir, "outside.txt");
    writeFileSync(outsideTarget, "escaped");
    symlinkSync(outsideTarget, join(linkBase, "bad-link.txt"));
    assert.throws(
      () => checkSelfContainedSymlinks(linkBase, linkBase + "/"),
      /Symlink escapes application bundle/,
    );

    // 3. Test validateInfoPlistContent
    const validPlist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIconFile</key><string>Sumi</string>
<key>CFBundleIdentifier</key><string>local.sumi.journal</string>
<key>CFBundleShortVersionString</key><string>0.2.0</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSMicrophoneUsageDescription</key><string>Voice dictation</string>
</dict></plist>`;
    validateInfoPlistContent(validPlist, "0.2.0");

    assert.throws(
      () => validateInfoPlistContent(validPlist, "0.3.0"),
      /CFBundleShortVersionString must match 0.3.0/,
    );

    const badIdPlist = validPlist.replace("local.sumi.journal", "com.example.app");
    assert.throws(
      () => validateInfoPlistContent(badIdPlist, "0.2.0"),
      /CFBundleIdentifier must be/,
    );

    const badSysPlist = validPlist.replace("14.0", "13.0");
    assert.throws(
      () => validateInfoPlistContent(badSysPlist, "0.2.0"),
      /LSMinimumSystemVersion must be >= 14.0/,
    );

    // 4. Test verifyAppPackage
    const mockResources = join(tempDir, "mock-resources");
    const mockApp = join(mockResources, "app");
    mkdirSync(mockApp, { recursive: true });
    writeFileSync(
      join(mockApp, "package.json"),
      JSON.stringify({ main: "main.cjs", version: "0.2.0" }),
    );
    for (const f of ["main.cjs", "preload.cjs", "preferences.cjs", "security.cjs"]) {
      writeFileSync(join(mockApp, f), "// shell");
    }
    verifyAppPackage(mockResources, "0.2.0");

    assert.throws(
      () => verifyAppPackage(mockResources, "0.2.1"),
      /version \(0\.2\.0\) must match root version \(0\.2\.1\)/,
    );

    // 5. Test findLicenseFile
    const mockLicenses = join(tempDir, "mock-lic");
    mkdirSync(mockLicenses, { recursive: true });
    const shortLic = join(mockLicenses, "short.txt");
    writeFileSync(shortLic, "short");
    assert.throws(() => findLicenseFile([shortLic], "TestLic"), /missing or too short/);

    const longLic = join(mockLicenses, "long.txt");
    writeFileSync(longLic, "A".repeat(150));
    assert.equal(findLicenseFile([longLic], "TestLic"), longLic);

    // 6. Test verifyElectronFramework with a SYNTHETIC mock framework (bounded,
    //    no real 200MB binary, and `strings` must NEVER be invoked)
    const mockContents = join(tempDir, "mock-contents");
    const mockFw = join(mockContents, "Frameworks/Electron Framework.framework");
    mkdirSync(join(mockFw, "Resources"), { recursive: true });
    mkdirSync(join(mockContents, "MacOS"), { recursive: true });
    writeFileSync(join(mockContents, "MacOS/Sumi"), "#!/bin/sh\n"); // fake executable
    writeFileSync(join(mockFw, "Electron Framework"), "fake-macho"); // fake binary, tiny
    const fwPlistXml = (v) => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>local.sumi.journal.framework</string>
<key>CFBundleShortVersionString</key><string>${v}</string>
<key>CFBundleVersion</key><string>${v}</string>
</dict></plist>`;
    writeFileSync(join(mockFw, "Resources/Info.plist"), fwPlistXml(EXPECTED_ELECTRON_VERSION));

    const toolCalls = [];
    const mockRunTool = (cmd, args, opts) => {
      toolCalls.push({ cmd, args, maxBuffer: opts && opts.maxBuffer });
      assert.notEqual(
        cmd,
        "strings",
        "verifyElectronFramework must never invoke `strings` on binaries",
      );
      if (cmd === "otool") return "Electron Framework.framework/Versions/A/Electron Framework";
      if (cmd === "file") return "Mach-O 64-bit executable arm64";
      if (cmd === "lipo") return "Non-fat file: fake-macho is architecture: arm64";
      return "";
    };

    // Happy path: framework plist pins 45.2.3 -> passes, all tool output bounded
    verifyElectronFramework(mockContents, mockRunTool);
    assert.ok(toolCalls.every((c) => c.maxBuffer === TOOL_OUTPUT_MAX_BUFFER));
    assert.ok(toolCalls.some((c) => c.cmd === "otool"));

    // Wrong vendor version (e.g. root app version 0.2.0 stamped by mistake) -> FAIL
    writeFileSync(join(mockFw, "Resources/Info.plist"), fwPlistXml("0.2.0"));
    assert.throws(
      () => verifyElectronFramework(mockContents, mockRunTool),
      /CFBundleShortVersionString must be 45\.2\.3/,
    );
    // Correct short version but wrong build version -> also FAIL
    writeFileSync(
      join(mockFw, "Resources/Info.plist"),
      fwPlistXml("45.2.3").replace(
        "<key>CFBundleVersion</key><string>45.2.3</string>",
        "<key>CFBundleVersion</key><string>0.2.0</string>",
      ),
    );
    assert.throws(
      () => verifyElectronFramework(mockContents, mockRunTool),
      /CFBundleVersion must be 45\.2\.3/,
    );

    // extractPlistString helper
    assert.equal(extractPlistString(fwPlistXml("1.2.3"), "CFBundleShortVersionString"), "1.2.3");
    assert.equal(extractPlistString(fwPlistXml("1.2.3"), "CFBundleVersion"), "1.2.3");
    assert.equal(extractPlistString("<dict></dict>", "CFBundleVersion"), null);

    console.log("All check-support unit tests passed successfully.");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runUnitTests();
}
