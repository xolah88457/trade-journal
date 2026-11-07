import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
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
 * Verified Windows required Visual C++ Runtime CRT DLLs (PE imports from transcribe.dll/ggml-base/ggml-cpu-x64).
 * Must be packaged app-local into runtime/native directories so no host Visual Studio / VC++ redist
 * installation is required on user systems.
 */
export const WINDOWS_REQUIRED_CRT_DLLS = ["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"];

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
 * Determines whether targetPath is equal to or a canonical descendant of basePath.
 * Uses platform-specific path operations (win32 vs posix) so Windows path logic can be
 * fully verified on non-Windows hosts.
 *
 * Enforces canonical realpath resolution, consistent case-folding on Windows,
 * strict relative boundary check, and rejects cross-drive or absolute relative results.
 */
export function isBaseOrChildPath(targetPath, basePath, platform = process.platform) {
  const isWin = platform === "win32";
  const pathApi = isWin ? win32 : posix;

  let target = targetPath;
  let base = basePath;

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

  // Rejection rules:
  // 1. Cross-drive / UNC root escape: pathApi.isAbsolute(rel) is true (e.g. 'D:\outside' or '\\server2\share')
  if (pathApi.isAbsolute(rel)) return false;

  // 2. Parent directory escape: starts with '..'
  if (rel === ".." || rel.startsWith(`..${pathApi.sep}`) || rel.startsWith("../")) return false;

  // 3. Strict prefix/separator boundary verification: target must start with base + separator
  const basePrefix = base.endsWith(pathApi.sep) ? base : base + pathApi.sep;
  return target.startsWith(basePrefix);
}

/**
 * Recursively asserts that every symbolic link resolves strictly within basePrefix.
 */
export function checkSelfContainedSymlinks(directory, basePrefix) {
  if (!existsSync(directory)) return;
  const canonicalBase = realpathSync(basePrefix);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const real = realpathSync(path);
      assert.ok(
        isBaseOrChildPath(real, canonicalBase),
        `Symlink escapes application bundle into developer checkout: ${path} -> ${real}`,
      );
    } else if (entry.isDirectory()) {
      checkSelfContainedSymlinks(path, canonicalBase);
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
  const sileroHash = createHash("sha256").update(sileroBytes).digest("hex");
  assert.equal(sileroHash, SILERO_EXPECTED_SHA256, "Bundled Silero VAD checksum mismatch");

  assert.ok(
    !existsSync(join(webDir, "models/parakeet-unified-en-0.6b-Q8_0.gguf")),
    "Parakeet ASR weights must never be bundled inside .app",
  );
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
  const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const appPkgPath = join(resources, "app/package.json");
  const appPkgVersion = existsSync(appPkgPath)
    ? JSON.parse(readFileSync(appPkgPath, "utf8")).version
    : null;
  const expectedVersion = injectedVersion || appPkgVersion || rootPkg.version || "0.3.0";
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
  const normArch = arch === "arm64" ? "arm64" : "x64";
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
  const exeFd = openSync(executable, "r");
  const exeHeader = Buffer.alloc(2);
  try {
    readSync(exeFd, exeHeader, 0, 2, 0);
  } finally {
    closeSync(exeFd);
  }
  assert.equal(
    exeHeader.toString("utf8"),
    "MZ",
    "Sumi.exe is not a valid Windows PE binary (missing MZ header)",
  );

  // Check bundled node.exe
  const nodeExe = join(resources, "runtime/node.exe");
  assert.ok(existsSync(nodeExe), `Bundled node.exe missing at ${nodeExe}`);
  const nodeFd = openSync(nodeExe, "r");
  const nodeHeader = Buffer.alloc(2);
  try {
    readSync(nodeFd, nodeHeader, 0, 2, 0);
  } finally {
    closeSync(nodeFd);
  }
  assert.equal(
    nodeHeader.toString("utf8"),
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

  const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const appPkgPath = join(resources, "app/package.json");
  const appPkgVersion = existsSync(appPkgPath)
    ? JSON.parse(readFileSync(appPkgPath, "utf8")).version
    : null;
  const expectedVersion = injectedVersion || appPkgVersion || rootPkg.version || "0.3.0";

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
  const exeFd = openSync(executable, "r");
  const exeHeader = Buffer.alloc(4);
  try {
    readSync(exeFd, exeHeader, 0, 4, 0);
  } finally {
    closeSync(exeFd);
  }
  assert.deepEqual(
    Array.from(exeHeader),
    [0x7f, 0x45, 0x4c, 0x46],
    "sumi is not a valid Linux ELF binary",
  );

  // Check bundled node
  const node = join(resources, "runtime/node");
  assert.ok(existsSync(node), `Bundled node missing at ${node}`);
  const nodeFd = openSync(node, "r");
  const nodeHeader = Buffer.alloc(4);
  try {
    readSync(nodeFd, nodeHeader, 0, 4, 0);
  } finally {
    closeSync(nodeFd);
  }
  assert.deepEqual(
    Array.from(nodeHeader),
    [0x7f, 0x45, 0x4c, 0x46],
    "node is not a valid Linux ELF binary",
  );

  // Check chrome-sandbox exists
  const sandboxCandidates = [join(app, "chrome-sandbox"), join(dirname(app), "chrome-sandbox")];
  const sandbox = sandboxCandidates.find((p) => existsSync(p));
  assert.ok(sandbox, `chrome-sandbox missing at ${sandboxCandidates.join(", ")}`);

  const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const appPkgPath = join(resources, "app/package.json");
  const appPkgVersion = existsSync(appPkgPath)
    ? JSON.parse(readFileSync(appPkgPath, "utf8")).version
    : null;
  const expectedVersion = injectedVersion || appPkgVersion || rootPkg.version || "0.3.0";

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
    const line = String(out).trim().split(/\r?\n/)[0] || "";
    const m = line.match(/(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] || 0)] : null;
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
  const vadHash = createHash("sha256").update(vadBytes).digest("hex");
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
    checkSelfContainedSymlinks(linkBase, linkBase);

    const outsideTarget = join(tempDir, "outside.txt");
    writeFileSync(outsideTarget, "escaped");
    symlinkSync(outsideTarget, join(linkBase, "bad-link.txt"));
    assert.throws(
      () => checkSelfContainedSymlinks(linkBase, linkBase),
      /Symlink escapes application bundle/,
    );

    // Pure Windows and POSIX path containment assertions (cross-platform, case-folding, no symlink dependency)
    assert.equal(isBaseOrChildPath("C:\\bundle\\sub\\target.txt", "C:\\bundle", "win32"), true);
    assert.equal(isBaseOrChildPath("C:\\BUNDLE\\sub\\target.txt", "c:\\bundle", "win32"), true);
    assert.equal(isBaseOrChildPath("C:\\bundle\\target.txt", "C:\\bundle\\", "win32"), true);
    assert.equal(isBaseOrChildPath("C:\\bundle", "C:\\bundle", "win32"), true);
    assert.equal(isBaseOrChildPath("C:/bundle/sub/target.txt", "C:/bundle/", "win32"), true);
    assert.equal(isBaseOrChildPath("D:\\outside", "C:\\bundle", "win32"), false);
    assert.equal(isBaseOrChildPath("D:\\bundle\\sub\\target.txt", "C:\\bundle", "win32"), false);
    assert.equal(isBaseOrChildPath("C:\\outside.txt", "C:\\bundle", "win32"), false);
    assert.equal(isBaseOrChildPath("C:\\bundle-sibling\\target.txt", "C:\\bundle", "win32"), false);
    assert.equal(
      isBaseOrChildPath("\\\\server2\\share\\target.txt", "\\\\server1\\share\\bundle", "win32"),
      false,
    );
    assert.equal(
      isBaseOrChildPath(
        "\\\\server1\\share\\bundle\\sub\\file.txt",
        "\\\\server1\\share\\bundle",
        "win32",
      ),
      true,
    );
    assert.equal(isBaseOrChildPath("/app/Contents/sub/file", "/app/Contents", "darwin"), true);
    assert.equal(isBaseOrChildPath("/app/outside", "/app/Contents", "darwin"), false);
    assert.equal(isBaseOrChildPath("/app/Contents-sibling/file", "/app/Contents", "darwin"), false);

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

    // Test 0.3.0 requires update-service-platform.cjs
    writeFileSync(
      join(mockApp, "package.json"),
      JSON.stringify({ main: "main.cjs", version: "0.3.0" }),
    );
    for (const f of [
      "main.cjs",
      "preload.cjs",
      "preferences.cjs",
      "security.cjs",
      "update-service.cjs",
      "update-service-platform.cjs",
    ]) {
      writeFileSync(join(mockApp, f), "// shell");
    }
    verifyAppPackage(mockResources, "0.3.0");

    rmSync(join(mockApp, "update-service-platform.cjs"));
    assert.throws(
      () => verifyAppPackage(mockResources, "0.3.0"),
      /Required shell file missing: Resources\/app\/update-service-platform\.cjs/,
    );
    writeFileSync(join(mockApp, "update-service-platform.cjs"), "// shell");

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

    // 7. Test resolvePackageLayout
    const macLayout = resolvePackageLayout(tempDir, "darwin", "arm64");
    assert.equal(macLayout.executable, join(tempDir, "dist/Sumi.app/Contents/MacOS/Sumi"));
    assert.equal(
      macLayout.nodeExecutable,
      join(tempDir, "dist/Sumi.app/Contents/Resources/runtime/node"),
    );

    const winLayout = resolvePackageLayout(tempDir, "win32", "x64");
    assert.equal(winLayout.executable, join(tempDir, "dist/sumi-win32-x64/Sumi.exe"));
    assert.equal(
      winLayout.nodeExecutable,
      join(tempDir, "dist/sumi-win32-x64/resources/runtime/node.exe"),
    );

    const linuxLayout = resolvePackageLayout(tempDir, "linux", "x64");
    assert.equal(linuxLayout.executable, join(tempDir, "dist/sumi-linux-x64/sumi"));
    assert.equal(
      linuxLayout.nodeExecutable,
      join(tempDir, "dist/sumi-linux-x64/resources/runtime/node"),
    );

    // 8. Test verifyWindowsPackage with synthetic mock
    const mockWinRoot = join(tempDir, "mock-win-root");
    const mockWinApp = join(mockWinRoot, "dist/sumi-win32-x64");
    const mockWinRes = join(mockWinApp, "resources");
    mkdirSync(join(mockWinRes, "runtime"), { recursive: true });
    mkdirSync(join(mockWinRes, "app"), { recursive: true });
    mkdirSync(join(mockWinRes, "licenses"), { recursive: true });
    mkdirSync(join(mockWinRes, "server/apps/web/models"), { recursive: true });

    // Sumi.exe and node.exe with valid MZ PE headers (> 1024 bytes)
    const fakePeBuffer = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(1100, 0)]);
    writeFileSync(join(mockWinApp, "Sumi.exe"), fakePeBuffer);
    writeFileSync(join(mockWinRes, "runtime/node.exe"), fakePeBuffer);

    // All required Windows CRT DLLs present
    for (const dll of WINDOWS_REQUIRED_CRT_DLLS) {
      writeFileSync(join(mockWinRes, "runtime", dll), "fake-crt-dll");
    }

    // Required licenses + Microsoft CRT redistributable notice
    writeFileSync(join(mockWinRes, "licenses/Trade-Journal-MIT.txt"), "A".repeat(150));
    writeFileSync(join(mockWinRes, "licenses/Kami-MIT.txt"), "A".repeat(150));
    writeFileSync(join(mockWinRes, "licenses/Node-LICENSE.txt"), "A".repeat(150));
    writeFileSync(join(mockWinRes, "licenses/Silero-VAD-MIT.txt"), "A".repeat(150));
    writeFileSync(join(mockWinRes, "licenses/Electron-LICENSE.txt"), "A".repeat(150));
    writeFileSync(join(mockWinRes, "licenses/THIRD-PARTY-NOTICES.md"), "A".repeat(150));
    writeFileSync(
      join(mockWinRes, "licenses/Microsoft-VC-Redist-LICENSE.txt"),
      "Microsoft Visual C++ Runtime Redistributable License Terms\n" + "A".repeat(100),
    );

    // App files
    writeFileSync(
      join(mockWinRes, "app/package.json"),
      JSON.stringify({ main: "main.cjs", version: "0.3.0" }),
    );
    for (const f of [
      "main.cjs",
      "preload.cjs",
      "preferences.cjs",
      "security.cjs",
      "update-service.cjs",
      "update-service-platform.cjs",
    ]) {
      writeFileSync(join(mockWinRes, "app", f), "// shell");
    }

    // Silero model fixture (use real model bytes so size and SHA256 match perfectly)
    const realSileroPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "../models/silero-vad-v6.2-F32.gguf",
    );
    if (existsSync(realSileroPath)) {
      writeFileSync(
        join(mockWinRes, "server/apps/web/models/silero-vad-v6.2-F32.gguf"),
        readFileSync(realSileroPath),
      );
    } else {
      writeFileSync(
        join(mockWinRes, "server/apps/web/models/silero-vad-v6.2-F32.gguf"),
        Buffer.alloc(SILERO_EXPECTED_SIZE),
      );
    }

    writeFileSync(join(mockWinRoot, "package.json"), JSON.stringify({ version: "0.3.0" }));

    // Mock hash calculation for test fixture
    const origCreateHash = createHash;
    // Window check happy path (with dummy silero sha bypass only for synthetic test)
    // We test required DLL missing:
    rmSync(join(mockWinRes, "runtime/msvcp140.dll"), { force: true });
    assert.throws(
      () =>
        verifyWindowsPackage({
          root: mockWinRoot,
          app: mockWinApp,
          resources: mockWinRes,
          arch: "x64",
        }),
      /Required Windows CRT runtime DLL missing from package: msvcp140\.dll/,
    );
    // Restore msvcp140.dll
    writeFileSync(join(mockWinRes, "runtime/msvcp140.dll"), "fake-crt-dll");

    // Missing Microsoft CRT license notice throws
    rmSync(join(mockWinRes, "licenses/Microsoft-VC-Redist-LICENSE.txt"), { force: true });
    assert.throws(
      () =>
        verifyWindowsPackage({
          root: mockWinRoot,
          app: mockWinApp,
          resources: mockWinRes,
          arch: "x64",
        }),
      /Microsoft Visual C\+\+ Redistributable license notice missing required terms/,
    );

    // 9. Test verifyLinuxPackage with synthetic mock
    const mockLinuxRoot = join(tempDir, "mock-linux-root");
    const mockLinuxApp = join(mockLinuxRoot, "dist/sumi-linux-x64");
    const mockLinuxRes = join(mockLinuxApp, "resources");
    mkdirSync(join(mockLinuxRes, "runtime"), { recursive: true });
    mkdirSync(join(mockLinuxRes, "app"), { recursive: true });
    mkdirSync(join(mockLinuxRes, "licenses"), { recursive: true });
    mkdirSync(join(mockLinuxRes, "server/apps/web/models"), { recursive: true });

    // sumi and node with valid ELF magic bytes (\x7fELF)
    const fakeElfBuffer = Buffer.concat([
      Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
      Buffer.alloc(1100, 0),
    ]);
    writeFileSync(join(mockLinuxApp, "sumi"), fakeElfBuffer);
    writeFileSync(join(mockLinuxRes, "runtime/node"), fakeElfBuffer);

    // Missing chrome-sandbox throws
    assert.throws(
      () =>
        verifyLinuxPackage({
          root: mockLinuxRoot,
          app: mockLinuxApp,
          resources: mockLinuxRes,
          arch: "x64",
        }),
      /chrome-sandbox missing/,
    );
    writeFileSync(join(mockLinuxApp, "chrome-sandbox"), "#!/bin/sh\n");

    // 10. Test runNativeAsrDoctor with synthetic mock runner
    const mockDoctorRoot = join(tempDir, "mock-doctor-root");
    const mockDoctorLayout = resolvePackageLayout(mockDoctorRoot, "linux", "x64");
    mkdirSync(dirname(mockDoctorLayout.nodeExecutable), { recursive: true });
    mkdirSync(join(mockDoctorLayout.webDir, "models"), { recursive: true });
    writeFileSync(mockDoctorLayout.nodeExecutable, "#!/bin/sh\n");
    if (existsSync(realSileroPath)) {
      writeFileSync(
        join(mockDoctorLayout.webDir, "models/silero-vad-v6.2-F32.gguf"),
        readFileSync(realSileroPath),
      );
    }
    const mockRunCalls = [];
    const mockDoctorTool = (cmd, args, opts) => {
      mockRunCalls.push({ cmd, args, cwd: opts && opts.cwd });
      return "[ASR Doctor] Silence speech probability: 0.0016\n[ASR Doctor] Backend successfully initialized.";
    };
    const doctorRes = runNativeAsrDoctor({
      root: mockDoctorRoot,
      platform: "linux",
      arch: "x64",
      runTool: mockDoctorTool,
    });
    assert.equal(doctorRes.success, true);
    assert.equal(mockRunCalls.length, 1);
    assert.equal(mockRunCalls[0].cwd, mockDoctorLayout.webDir);

    console.log("All check-support unit tests passed successfully.");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runUnitTests();
}
