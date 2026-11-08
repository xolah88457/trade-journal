import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkNoPrivateFiles,
  checkSelfContainedSymlinks,
  isPathContained,
  normalizeArch,
  probeDllFileVersion,
  readFileHead,
  readRootVersion,
  sha256Hex,
} from "./lib/common.mjs";

export { checkNoPrivateFiles, checkSelfContainedSymlinks };

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
 * Verified Windows required Visual C++ Runtime CRT DLLs (PE imports from transcribe.dll/ggml-base/ggml-cpu-x64).
 * Must be packaged app-local into runtime/native directories so no host Visual Studio / VC++ redist
 * installation is required on user systems.
 */
export const WINDOWS_REQUIRED_CRT_DLLS = ["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"];

/**
 * Determines whether targetPath is equal to or a canonical descendant of basePath
 * (see isPathContained in lib/common.mjs; argument order here is target first).
 */
export function isBaseOrChildPath(targetPath, basePath, platform = process.platform) {
  return isPathContained(basePath, targetPath, platform);
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

  // Shell entrypoints, security, and updater modules
  const requiredScripts = ["main.cjs", "preload.cjs", "preferences.cjs", "security.cjs"];
  if (expectedVersion !== "0.2.0") {
    requiredScripts.push("update-service.cjs", "update-service-platform.cjs");
  } else {
    // If update-service.cjs is packaged in 0.2.0, verify it is non-empty
    const updateService = join(appDir, "update-service.cjs");
    if (existsSync(updateService)) {
      assert.ok(
        readFileSync(updateService, "utf8").trim().length > 0,
        "Resources/app/update-service.cjs must not be empty",
      );
    }
  }

  for (const file of requiredScripts) {
    const filePath = join(appDir, file);
    assert.ok(existsSync(filePath), `Required shell file missing: Resources/app/${file}`);
    assert.ok(
      readFileSync(filePath, "utf8").trim().length > 0,
      `Resources/app/${file} must not be empty`,
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
  const sileroHash = sha256Hex(sileroBytes);
  assert.equal(sileroHash, SILERO_EXPECTED_SHA256, "Bundled Silero VAD checksum mismatch");

  assert.ok(
    !existsSync(join(webDir, "models/parakeet-unified-en-0.6b-Q8_0.gguf")),
    "Parakeet ASR weights must never be bundled inside .app",
  );
}

/**
 * The version a packaged app must carry: an explicit override, else the packaged
 * Resources/app/package.json version, else the root package.json version.
 */
function resolveExpectedVersion(root, resources, injectedVersion) {
  if (injectedVersion) return injectedVersion;
  const appPkgPath = join(resources, "app/package.json");
  const appPkgVersion = existsSync(appPkgPath)
    ? JSON.parse(readFileSync(appPkgPath, "utf8")).version
    : null;
  return appPkgVersion || readRootVersion(root);
}

/**
 * Comprehensive verification for the complete packaged macOS Electron bundle.
 */
export function verifyElectronPackage({
  app,
  resources,
  root,
  runTool = execFileSync,
  expectedVersion: injectedVersion,
}) {
  assert.ok(existsSync(join(app, "MacOS/Sumi")), "Run pnpm desktop:build first.");
  assert.ok(existsSync(join(resources, "Sumi.icns")), "Application icon Sumi.icns missing.");

  // Electron framework requirements & Mach-O verification
  verifyElectronFramework(app, runTool);

  // Info.plist validation
  runTool("plutil", ["-lint", join(app, "Info.plist")]);
  const plistContent = readFileSync(join(app, "Info.plist"), "utf8");
  const expectedVersion = resolveExpectedVersion(root, resources, injectedVersion);
  validateInfoPlistContent(plistContent, expectedVersion);

  // Codesign verification (deep, strict, works ad-hoc)
  runTool("codesign", ["--verify", "--deep", "--strict", join(app, "..")]);

  // Portable Node runtime check (must not link homebrew or macports)
  const node = join(resources, "runtime/node");
  assert.ok(existsSync(node), "Bundled node binary missing");
  const linkedNode = runTool("otool", ["-L", node], { encoding: "utf8" });
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

/**
 * Resolves the standardized package layout across macOS, Windows, and Linux.
 */
export function resolvePackageLayout(root, platform = process.platform, arch = process.arch) {
  const normArch = normalizeArch(arch);
  if (platform === "darwin") {
    const app = join(root, "dist/Sumi.app/Contents");
    const resources = join(app, "Resources");
    return {
      platform,
      arch: normArch,
      app,
      appDir: join(root, "dist/Sumi.app"),
      resources,
      executable: join(app, "MacOS/Sumi"),
      nodeExecutable: join(resources, "runtime/node"),
      launchScript: join(resources, "launch.cjs"),
      webDir: join(resources, "server/apps/web"),
      serverDir: join(resources, "server"),
      appDirEntry: join(resources, "app"),
    };
  }

  if (platform === "win32") {
    const appDir = join(root, `dist/sumi-win32-${normArch}`);
    const resources = join(appDir, "resources");
    return {
      platform,
      arch: normArch,
      app: appDir,
      appDir,
      resources,
      executable: join(appDir, "Sumi.exe"),
      nodeExecutable: join(resources, "runtime/node.exe"),
      launchScript: join(resources, "launch.cjs"),
      webDir: join(resources, "server/apps/web"),
      serverDir: join(resources, "server"),
      appDirEntry: join(resources, "app"),
    };
  }

  // linux
  const appDir = join(root, `dist/sumi-linux-${normArch}`);
  const resources = join(appDir, "resources");
  return {
    platform,
    arch: normArch,
    app: appDir,
    appDir,
    resources,
    executable: join(appDir, "sumi"),
    nodeExecutable: join(resources, "runtime/node"),
    launchScript: join(resources, "launch.cjs"),
    webDir: join(resources, "server/apps/web"),
    serverDir: join(resources, "server"),
    appDirEntry: join(resources, "app"),
  };
}

/**
 * Comprehensive verification for the complete packaged Windows Electron bundle.
 * Enforces bounded PE header checks, required VS Redist CRT DLLs, and licenses.
 */
export function verifyWindowsPackage({
  root,
  app,
  resources,
  arch = "x64",
  runTool = execFileSync,
  expectedVersion: injectedVersion,
}) {
  const executable = join(app, "Sumi.exe");
  assert.ok(
    existsSync(executable),
    `Windows executable missing at ${executable}. Run 'pnpm desktop:build' first.`,
  );
  const exeStat = statSync(executable);
  assert.ok(exeStat.size > 1024, `Sumi.exe too small (${exeStat.size} bytes)`);

  // Bounded PE header check (first 2 bytes 'MZ') - NEVER scan large binaries with strings
  assert.equal(
    readFileHead(executable, 2).toString("utf8"),
    "MZ",
    "Sumi.exe is not a valid Windows PE binary (missing MZ header)",
  );

  // Check bundled node.exe
  const nodeExe = join(resources, "runtime/node.exe");
  assert.ok(existsSync(nodeExe), `Bundled node.exe missing at ${nodeExe}`);
  assert.equal(
    readFileHead(nodeExe, 2).toString("utf8"),
    "MZ",
    "node.exe is not a valid Windows PE binary (missing MZ header)",
  );

  // Structural required-runtime DLL check: MSVCP140.dll, VCRUNTIME140.dll, VCRUNTIME140_1.dll
  // These are required by published transcribe.dll/ggml-base/ggml-cpu-x64 and must be shipped app-local.
  for (const dll of WINDOWS_REQUIRED_CRT_DLLS) {
    const candidates = [
      join(resources, "runtime", dll),
      join(resources, "runtime", dll.toUpperCase()),
      join(resources, "server/node_modules/@transcribe-cpp/win32-x64-cpu-vulkan", dll),
      join(resources, "server/apps/web/node_modules/@transcribe-cpp/win32-x64-cpu-vulkan", dll),
      join(app, dll),
      join(app, "resources", "runtime", dll),
    ];
    const found = candidates.find((p) => existsSync(p) && statSyncSafe(p).size > 0);
    assert.ok(
      found,
      `Required Windows CRT runtime DLL missing from package: ${dll}. Windows native portability requires app-local MSVCP140/VCRUNTIME140 CRT DLLs.`,
    );
  }

  // Structural check for Microsoft CRT license notice
  const crtNoticePath = findLicenseFile(
    [
      join(resources, "licenses/Microsoft-VC-Redist-LICENSE.txt"),
      join(resources, "licenses/VC-Redist-LICENSE.txt"),
      join(resources, "licenses/MICROSOFT-SOFTWARE-LICENSE-TERMS.txt"),
      join(resources, "licenses/THIRD-PARTY-NOTICES.md"),
    ],
    "Microsoft Visual C++ Redistributable / CRT license notice",
  );
  const crtNoticeText = readFileSync(crtNoticePath, "utf8");
  assert.match(
    crtNoticeText,
    /Visual C\+\+|Redistributable|VCRUNTIME|MSVCP/i,
    "Microsoft Visual C++ Redistributable license notice missing required terms",
  );

  const expectedVersion = resolveExpectedVersion(root, resources, injectedVersion);

  verifyAppPackage(resources, expectedVersion);
  verifyLicenses(resources, app);
  verifySileroModel(join(resources, "server/apps/web"));
  checkNoPrivateFiles(join(resources, "server"));
  checkNoPrivateFiles(join(resources, "app"));
}

/**
 * Comprehensive verification for the complete packaged Linux Electron bundle.
 * Enforces bounded ELF header checks, chrome-sandbox existence, and licenses.
 */
export function verifyLinuxPackage({
  root,
  app,
  resources,
  arch = "x64",
  runTool = execFileSync,
  expectedVersion: injectedVersion,
}) {
  const executable = join(app, "sumi");
  assert.ok(
    existsSync(executable),
    `Linux executable missing at ${executable}. Run 'pnpm desktop:build' first.`,
  );
  const exeStat = statSync(executable);
  assert.ok(exeStat.size > 1024, `sumi binary too small (${exeStat.size} bytes)`);

  // Bounded ELF header check (first 4 bytes '\x7fELF') - NEVER scan large binaries with strings
  assert.deepEqual(
    Array.from(readFileHead(executable, 4)),
    [0x7f, 0x45, 0x4c, 0x46],
    "sumi is not a valid Linux ELF binary",
  );

  // Check bundled node
  const node = join(resources, "runtime/node");
  assert.ok(existsSync(node), `Bundled node missing at ${node}`);
  assert.deepEqual(
    Array.from(readFileHead(node, 4)),
    [0x7f, 0x45, 0x4c, 0x46],
    "node is not a valid Linux ELF binary",
  );

  // Check chrome-sandbox exists
  const sandboxCandidates = [join(app, "chrome-sandbox"), join(dirname(app), "chrome-sandbox")];
  const sandbox = sandboxCandidates.find((p) => existsSync(p));
  assert.ok(sandbox, `chrome-sandbox missing at ${sandboxCandidates.join(", ")}`);

  const expectedVersion = resolveExpectedVersion(root, resources, injectedVersion);

  verifyAppPackage(resources, expectedVersion);
  verifyLicenses(resources, app);
  verifySileroModel(join(resources, "server/apps/web"));
  checkNoPrivateFiles(join(resources, "server"));
  checkNoPrivateFiles(join(resources, "app"));
}

/**
 * Dispatches package verification to the appropriate OS handler.
 * Never skips Windows or Linux with a false pass.
 */
export function verifyPackageForPlatform({
  root,
  platform = process.platform,
  arch = process.arch,
  runTool = execFileSync,
  expectedVersion,
}) {
  const layout = resolvePackageLayout(root, platform, arch);
  if (platform === "darwin") {
    return verifyElectronPackage({
      app: layout.app,
      resources: layout.resources,
      root,
      runTool,
      expectedVersion,
    });
  }
  if (platform === "win32") {
    return verifyWindowsPackage({
      root,
      app: layout.app,
      resources: layout.resources,
      arch: layout.arch,
      runTool,
      expectedVersion,
    });
  }
  if (platform === "linux") {
    return verifyLinuxPackage({
      root,
      app: layout.app,
      resources: layout.resources,
      arch: layout.arch,
      runTool,
      expectedVersion,
    });
  }
  throw new Error(`Unsupported platform: ${platform}`);
}

/**
 * Reads the PE FILEVERSION of a bundled Windows DLL via PowerShell FileVersionInfo.
 * Returns a 4-part numeric array, or null when unreadable. `runTool` is injectable for tests.
 */
export function readBundledDllFileVersion(filePath, runTool = execFileSync) {
  try {
    return probeDllFileVersion(filePath, runTool).version;
  } catch {
    return null;
  }
}

/** First existing bundled copy of a CRT DLL (case-insensitive), mirroring verifyWindowsPackage candidates. */
export function findBundledCrtDll(layout, dll) {
  const files = [
    join(layout.resources, "runtime", dll),
    join(layout.resources, "server/node_modules/@transcribe-cpp/win32-x64-cpu-vulkan", dll),
    join(
      layout.resources,
      "server/apps/web/node_modules/@transcribe-cpp/win32-x64-cpu-vulkan",
      dll,
    ),
    join(layout.app, dll),
    join(layout.app, "resources", "runtime", dll),
  ];
  for (const p of files) {
    if (existsSync(p)) return p;
  }
  for (const dir of [...new Set(files.map((p) => dirname(p)))]) {
    try {
      const match = readdirSync(dir).find((e) => e.toLowerCase() === dll.toLowerCase());
      if (match) return join(dir, match);
    } catch {}
  }
  return null;
}

/**
 * Prints the actual FILEVERSION of each bundled app-local CRT DLL (msvcp140.dll,
 * vcruntime140.dll, vcruntime140_1.dll) so CI logs show exactly which CRT the
 * bundled node + transcribe-cpp will load BEFORE any native load. Best-effort:
 * never throws; unreadable versions are reported as "unknown".
 */
export function reportBundledCrtVersions(layout, runTool = execFileSync, log = console.log) {
  const lines = [];
  for (const dll of WINDOWS_REQUIRED_CRT_DLLS) {
    const dllPath = findBundledCrtDll(layout, dll);
    if (!dllPath) {
      lines.push(`[ASR Doctor] Bundled CRT ${dll}: NOT FOUND in package`);
      continue;
    }
    const version = readBundledDllFileVersion(dllPath, runTool);
    lines.push(
      `[ASR Doctor] Bundled CRT ${dll}: FILEVERSION ${version ? version.join(".") : "unknown"} @ ${dllPath}`,
    );
  }
  for (const line of lines) {
    try {
      log(line);
    } catch {}
  }
  return lines;
}

/**
 * Real Native ASR backend doctor on each platform:
 * Runs the BUNDLED official Node + packaged transcribe-cpp 0.4.1,
 * loads the bundled Silero VAD model, runs silence detection (512 float32 samples),
 * and disposes cleanly.
 *
 * Catches Windows DLL / Linux SO / Koffi / native CPU fallback defects without a 700MB model download.
 * Imports from packaged server/apps/web cwd via real ESM export (package import-only).
 */
export function runNativeAsrDoctor({
  root,
  platform = process.platform,
  arch = process.arch,
  runTool = execFileSync,
}) {
  const layout = resolvePackageLayout(root, platform, arch);
  assert.ok(
    existsSync(layout.nodeExecutable),
    `Bundled node executable missing at ${layout.nodeExecutable}`,
  );
  assert.ok(existsSync(layout.webDir), `Packaged web server directory missing at ${layout.webDir}`);

  const vadModel = join(layout.webDir, "models/silero-vad-v6.2-F32.gguf");
  assert.ok(existsSync(vadModel), `Bundled Silero VAD model missing at ${vadModel}`);
  const vadBytes = readFileSync(vadModel);
  assert.equal(vadBytes.length, SILERO_EXPECTED_SIZE, "Bundled Silero VAD size mismatch");
  const vadHash = sha256Hex(vadBytes);
  assert.equal(vadHash, SILERO_EXPECTED_SHA256, "Bundled Silero VAD checksum mismatch");

  const doctorScriptPath = join(layout.webDir, ".asr-doctor-probe.mjs");

  const doctorCode = `
import assert from "node:assert/strict";
import { TranscribeModel, version, libraryPath } from "transcribe-cpp";

async function run() {
  console.log("[ASR Doctor] Starting native ASR backend verification...");
  const v = version();
  console.log("[ASR Doctor] transcribe-cpp binding: version=" + v.version + " commit=" + v.commit + " headerHash=" + v.headerHash + " library=" + libraryPath());
  const vadPath = ${JSON.stringify(vadModel)};
  console.log("[ASR Doctor] Loading Silero VAD from: " + vadPath);
  const vad = await TranscribeModel.load(vadPath);
  assert.ok(vad, "TranscribeModel.load returned null/undefined");
  assert.ok(Array.isArray(vad.roles) && vad.roles.includes("vad"), "Model does not provide VAD role");

  console.log("[ASR Doctor] Creating VadSession...");
  const session = vad.createVadSession();
  assert.ok(session, "createVadSession returned null/undefined");

  console.log("[ASR Doctor] Executing silence detection on 512 zero PCM samples...");
  const silence = new Float32Array(512);
  const result = await session.run(silence);
  assert.ok(result && Array.isArray(result.probs), "Expected VadResult.probs array");
  assert.ok(result.probs.length > 0, "VadResult.probs is empty");
  const speechProb = result.probs[0];
  console.log("[ASR Doctor] Speech probability for silence: " + speechProb);
  assert.ok(speechProb < 0.2, "Speech probability on silence is unexpectedly high: " + speechProb);

  console.log("[ASR Doctor] Disposing VadSession and TranscribeModel...");
  session.dispose();
  vad.dispose();
  console.log("[ASR Doctor] Backend successfully initialized, computed silence inference, and disposed without memory leak.");
}

run().catch((err) => {
  console.error("[ASR Doctor ERROR]", err);
  process.exit(1);
});
`;

  try {
    writeFileSync(doctorScriptPath, doctorCode, "utf8");

    const env = { ...process.env };
    if (platform === "win32") {
      const runtimeDir = join(layout.resources, "runtime");
      env.PATH = `${runtimeDir};${env.PATH || ""}`;
      // Print actual bundled CRT DLL FILEVERSIONs BEFORE native load so a stale
      // app-local msvcp140.dll (< 14.40 -> std::mutex ABI crash 0xC0000005 during
      // transcribe-cpp backend init, transcribe.cpp#210) is visible in CI logs.
      reportBundledCrtVersions(layout, runTool);
    }

    console.log(
      `[ASR Doctor] Invoking bundled node (${layout.nodeExecutable}) in packaged cwd: ${layout.webDir}`,
    );
    const stdout = runTool(layout.nodeExecutable, [doctorScriptPath], {
      cwd: layout.webDir,
      env,
      encoding: "utf8",
      timeout: 45000,
    });

    console.log(
      "[ASR Doctor] Notice: Full Parakeet speech-to-text inference (~700MB model download) is not CI-run on Windows and Linux; instead, real native backend execution (Koffi FFI, native DLL/SO loading, GGUF tensor computation) is verified via bundled Silero VAD (1.2MB) load, silence detection, and clean disposal.",
    );

    return {
      success: true,
      platform,
      arch: layout.arch,
      output: stdout,
    };
  } finally {
    try {
      rmSync(doctorScriptPath, { force: true });
    } catch {}
  }
}

/**
 * CLI entry point (`node desktop/check-support.mjs`, run by the release workflow):
 * executes the helper unit tests in check-support.test.mjs with the node:test runner.
 */
function runUnitTests() {
  const testFile = join(dirname(fileURLToPath(import.meta.url)), "check-support.test.mjs");
  const result = spawnSync(process.execPath, ["--test", testFile], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  console.log("All check-support unit tests passed successfully.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runUnitTests();
}
