import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ELECTRON_VERSION = "45.2.3";

// Verified official Electron v45.2.3 Darwin asset SHA-256 hashes
export const PINNED_ELECTRON_CHECKSUMS = {
  "darwin-arm64": "4d7c429064087a47b855d9bd06c76ead4819b7f02b385de232d4a5c37ecef55f",
  "darwin-x64": "e619dacecaeda36f4bc708ac7df5a6bdcdfe2f554d5a4f5c0f47bcd66d51a86c",
};

// Verified via otool -l LC_BUILD_VERSION inspection:
// Electron 45.2.3 minos: 13.0
// Sparkle.framework minos: 11.0
// electron_sparkle.darwin-arm64.node (NAPI) minos: 14.0
// Maximum required system version across all runtime dependencies is 14.0 (macOS Sonoma).
export const LS_MINIMUM_SYSTEM_VERSION = "14.0";

export const REQUIRED_DESKTOP_SCRIPTS = [
  "main.cjs",
  "preload.cjs",
  "preferences.cjs",
  "security.cjs",
  "update-service.cjs",
];

export const DEFAULT_FEED_URL =
  "https://github.com/xolah88457/trade-journal/releases/latest/download/appcast.xml";

/**
 * Validates the Sparkle update feed URL.
 * MUST be a valid HTTPS URL - plain HTTP or any other scheme MUST throw.
 */
export function validateFeedUrl(feedUrl) {
  if (!feedUrl || typeof feedUrl !== "string") {
    throw new Error("Sparkle feedUrl is required and must be an HTTPS URL.");
  }
  let parsed;
  try {
    parsed = new URL(feedUrl);
  } catch {
    throw new Error(`Sparkle feedUrl must be a valid URL, got: ${feedUrl}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Sparkle feedUrl must use HTTPS, got protocol: ${parsed.protocol}`);
  }
  return feedUrl;
}

/**
 * Validates an Ed25519 public key as raw 32-byte base64.
 * Sparkle requires a valid Ed25519 public key for secure updates.
 * Empty or invalid keys MUST throw before any build/download/stage operations.
 */
export function validatePublicEdKey(key) {
  if (!key || typeof key !== "string") {
    throw new Error(
      "SUPublicEDKey is required: must be a valid raw 32-byte base64 Ed25519 public key.",
    );
  }
  const trimmed = key.trim();
  if (!trimmed) {
    throw new Error(
      "SUPublicEDKey is required: must be a valid raw 32-byte base64 Ed25519 public key.",
    );
  }
  // Strict base64 validation (RFC 4648)
  const base64Regex = /^[A-Za-z0-9+/]+={0,2}$/;
  if (!base64Regex.test(trimmed)) {
    throw new Error("SUPublicEDKey must be valid base64.");
  }
  let decoded;
  try {
    decoded = Buffer.from(trimmed, "base64");
  } catch {
    throw new Error("SUPublicEDKey must be valid base64.");
  }
  if (decoded.length !== 32) {
    throw new Error(
      `SUPublicEDKey must decode to exactly 32 bytes (Ed25519 public key), got ${decoded.length} bytes.`,
    );
  }
  return trimmed;
}

/**
 * Resolves and validates the canonical update configuration.
 *
 * Canonical source is desktop/update-config.json ({ feedUrl, publicEdKey });
 * environment overrides (SUMI_FEED_URL / SUFeedURL, SUMI_PUBLIC_ED_KEY / SUPublicEDKey)
 * take precedence when set. feedUrl defaults to DEFAULT_FEED_URL.
 *
 * Empty or invalid publicEdKey MUST THROW - SUPublicEDKey is never omitted.
 * This MUST run before any Next build / download / staging / replacement step,
 * so an unreleasable config fails the build immediately and loudly.
 */
export function resolveUpdateConfig({ config = {}, env = process.env } = {}) {
  let feedUrl = env.SUMI_FEED_URL || env.SUFeedURL || config.feedUrl || "";
  let publicEdKey = env.SUMI_PUBLIC_ED_KEY || env.SUPublicEDKey || config.publicEdKey || "";
  if (!feedUrl) {
    feedUrl = DEFAULT_FEED_URL;
  }
  validateFeedUrl(feedUrl);
  const validatedKey = validatePublicEdKey(publicEdKey);
  return { feedUrl, publicEdKey: validatedKey };
}

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

export function checkRequiredScripts(desktopDir) {
  for (const script of REQUIRED_DESKTOP_SCRIPTS) {
    const fullPath = join(desktopDir, script);
    if (!existsSync(fullPath)) {
      throw new Error(`Required desktop script missing: desktop/${script}. Build aborted.`);
    }
  }
}

export function assertFrameworkSymlinksConfined(frameworkPath) {
  if (!existsSync(frameworkPath)) return;
  const realBase = realpathSync(frameworkPath);
  const prefix = realBase + "/";
  function check(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const real = realpathSync(p);
        if (real !== realBase && !real.startsWith(prefix)) {
          throw new Error(`Framework symlink escapes bundle: ${p} -> ${real}`);
        }
      } else if (entry.isDirectory()) {
        check(p);
      }
    }
  }
  check(frameworkPath);
}

export function buildInfoPlist(version, options = {}) {
  const minSystemVersion = options.minSystemVersion || LS_MINIMUM_SYSTEM_VERSION;
  // SUFeedURL and SUPublicEDKey are ALWAYS emitted - never omitted.
  // Both are validated: HTTPS feed and raw 32-byte base64 Ed25519 key required.
  const suFeedUrl = validateFeedUrl(options.suFeedUrl || DEFAULT_FEED_URL);
  const suPublicEDKey = validatePublicEdKey(options.suPublicEDKey);
  const extraKeys = [];

  extraKeys.push(`\t<key>SUFeedURL</key>\n\t<string>${suFeedUrl}</string>`);
  extraKeys.push(`\t<key>SUPublicEDKey</key>\n\t<string>${suPublicEDKey}</string>`);
  extraKeys.push(`\t<key>SUEnableAutomaticChecks</key>\n\t<false/>`);
  extraKeys.push(`\t<key>SUAutomaticallyUpdate</key>\n\t<false/>`);

  const extraXml = extraKeys.length > 0 ? "\n" + extraKeys.join("\n") : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDisplayName</key>
	<string>Sumi</string>
	<key>CFBundleExecutable</key>
	<string>Sumi</string>
	<key>CFBundleIconFile</key>
	<string>Sumi</string>
	<key>CFBundleIdentifier</key>
	<string>local.sumi.journal</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>Sumi</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>${version}</string>
	<key>CFBundleVersion</key>
	<string>${version}</string>
	<key>LSApplicationCategoryType</key>
	<string>public.app-category.finance</string>
	<key>LSEnvironment</key>
	<dict>
		<key>MallocNanoZone</key>
		<string>0</string>
	</dict>
	<key>LSMinimumSystemVersion</key>
	<string>${minSystemVersion}</string>
	<key>NSAppTransportSecurity</key>
	<dict>
		<key>NSAllowsLocalNetworking</key>
		<true/>
	</dict>
	<key>NSHighResolutionCapable</key>
	<true/>
	<key>NSMainNibFile</key>
	<string>MainMenu</string>
	<key>NSMicrophoneUsageDescription</key>
	<string>Sumi uses the microphone for local voice dictation in journal notes. Audio is processed on-device and never sent to external servers.</string>
	<key>NSPrefersDisplaySafeAreaCompatibilityMode</key>
	<false/>
	<key>NSPrincipalClass</key>
	<string>AtomApplication</string>
	<key>NSQuitAlwaysKeepsWindows</key>
	<false/>
	<key>NSRequiresAquaSystemAppearance</key>
	<false/>
	<key>NSSupportsAutomaticGraphicsSwitching</key>
	<true/>
	<key>NSSupportsAutomaticTermination</key>
	<false/>
	<key>NSHumanReadableCopyright</key>
	<string>Based on MIT-licensed work by LuxAlgo Global, LLC and Tw93. Independent fork.</string>${extraXml}
</dict>
</plist>\n`;
}

export function buildHelperInfoPlist(helperId, helperName, version) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key>
	<string>${helperId}</string>
	<key>CFBundleName</key>
	<string>${helperName}</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>${version}</string>
	<key>CFBundleVersion</key>
	<string>${version}</string>
	<key>LSEnvironment</key>
	<dict>
		<key>MallocNanoZone</key>
		<string>0</string>
	</dict>
	<key>LSUIElement</key>
	<true/>
	<key>NSSupportsAutomaticGraphicsSwitching</key>
	<true/>
</dict>
</plist>\n`;
}

export function buildFrameworkInfoPlist(version) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key>
	<string>Electron Framework</string>
	<key>CFBundleIdentifier</key>
	<string>local.sumi.journal.framework</string>
	<key>CFBundleName</key>
	<string>Electron Framework</string>
	<key>CFBundlePackageType</key>
	<string>FMWK</string>
	<key>CFBundleShortVersionString</key>
	<string>${version}</string>
	<key>CFBundleVersion</key>
	<string>${version}</string>
	<key>LSEnvironment</key>
	<dict>
		<key>MallocNanoZone</key>
		<string>0</string>
	</dict>
	<key>NSSupportsAutomaticGraphicsSwitching</key>
	<true/>
</dict>
</plist>\n`;
}

export function buildEntitlementsXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>com.apple.security.cs.allow-jit</key>
	<true/>
	<key>com.apple.security.cs.allow-unsigned-executable-memory</key>
	<true/>
	<key>com.apple.security.cs.debugger</key>
	<true/>
	<key>com.apple.security.device.audio-input</key>
	<true/>
</dict>
</plist>\n`;
}

export async function ensureElectronArchive(cacheDir, arch = process.arch) {
  mkdirSync(cacheDir, { recursive: true });
  const electronArch = arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  const archiveName = `electron-v${ELECTRON_VERSION}-${electronArch}.zip`;
  const base = `https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}`;
  const archivePath = join(cacheDir, archiveName);
  const sumsPath = join(cacheDir, `electron-v${ELECTRON_VERSION}-SHASUMS256.txt`);

  const pinnedSha = PINNED_ELECTRON_CHECKSUMS[electronArch];

  let checksum = pinnedSha;
  if (existsSync(sumsPath)) {
    const sumsText = readFileSync(sumsPath, "utf8");
    const parsedChecksum = parseShaSums(sumsText, archiveName);
    if (parsedChecksum) checksum = parsedChecksum;
  }

  if (existsSync(archivePath) && checksum) {
    const fileBytes = readFileSync(archivePath);
    const hash = createHash("sha256").update(fileBytes).digest("hex");
    if (hash === checksum) {
      return { archivePath, checksum };
    }
  }

  const [archiveRes, sumsRes] = await Promise.all([
    fetch(`${base}/${archiveName}`, { signal: AbortSignal.timeout(180_000) }),
    fetch(`${base}/SHASUMS256.txt`, { signal: AbortSignal.timeout(30_000) }),
  ]);
  if (!archiveRes.ok || !sumsRes.ok) {
    throw new Error(
      `Failed to download official Electron v${ELECTRON_VERSION} (${archiveRes.status}/${sumsRes.status}).`,
    );
  }
  const sumsText = await sumsRes.text();
  checksum = parseShaSums(sumsText, archiveName);
  if (!checksum) {
    throw new Error(`Could not find checksum for ${archiveName} in official SHASUMS256.txt`);
  }
  if (pinnedSha && checksum !== pinnedSha) {
    throw new Error(
      `Official checksum for ${archiveName} (${checksum}) does not match pinned checksum (${pinnedSha})!`,
    );
  }

  const buffer = Buffer.from(await archiveRes.arrayBuffer());
  const actualHash = createHash("sha256").update(buffer).digest("hex");
  if (actualHash !== checksum) {
    throw new Error(`Electron archive checksum mismatch: expected ${checksum}, got ${actualHash}`);
  }
  writeFileSync(archivePath, buffer);
  writeFileSync(sumsPath, sumsText, "utf8");
  return { archivePath, checksum };
}

export async function ensureNodeArchive(
  cacheDir,
  runtimeVersion = process.version,
  arch = process.arch,
) {
  mkdirSync(cacheDir, { recursive: true });
  const archiveName = `node-${runtimeVersion}-darwin-${arch}.tar.gz`;
  const base = `https://nodejs.org/dist/${runtimeVersion}`;
  const archivePath = join(cacheDir, archiveName);
  const sumsPath = join(cacheDir, `node-${runtimeVersion}-SHASUMS256.txt`);

  let checksum = null;
  if (existsSync(sumsPath)) {
    const sumsText = readFileSync(sumsPath, "utf8");
    checksum = parseShaSums(sumsText, archiveName);
  }

  if (existsSync(archivePath) && checksum) {
    const fileBytes = readFileSync(archivePath);
    const hash = createHash("sha256").update(fileBytes).digest("hex");
    if (hash === checksum) {
      return { archivePath, checksum };
    }
  }

  const [archiveRes, sumsRes] = await Promise.all([
    fetch(`${base}/${archiveName}`, { signal: AbortSignal.timeout(120_000) }),
    fetch(`${base}/SHASUMS256.txt`, { signal: AbortSignal.timeout(30_000) }),
  ]);
  if (!archiveRes.ok || !sumsRes.ok) {
    throw new Error(
      `Failed to download official Node ${runtimeVersion} (${archiveRes.status}/${sumsRes.status}).`,
    );
  }
  const sumsText = await sumsRes.text();
  checksum = parseShaSums(sumsText, archiveName);
  if (!checksum) {
    throw new Error(`Could not find checksum for ${archiveName} in Node SHASUMS256.txt`);
  }
  const buffer = Buffer.from(await archiveRes.arrayBuffer());
  const actualHash = createHash("sha256").update(buffer).digest("hex");
  if (actualHash !== checksum) {
    throw new Error(`Node archive checksum mismatch: expected ${checksum}, got ${actualHash}`);
  }
  writeFileSync(archivePath, buffer);
  writeFileSync(sumsPath, sumsText, "utf8");
  return { archivePath, checksum };
}

export async function build() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (process.platform !== "darwin") throw new Error("Sumi's native desktop build requires macOS.");

  // Pre-flight 1: update config MUST be valid BEFORE any Next build, download,
  // staging, or dist replacement. Empty/invalid config.publicEdKey THROWS here,
  // and a non-HTTPS feedUrl THROWS here. SUPublicEDKey is never omitted.
  const updateConfigPath = join(root, "desktop/update-config.json");
  let rawUpdateConfig = {};
  if (existsSync(updateConfigPath)) {
    rawUpdateConfig = JSON.parse(readFileSync(updateConfigPath, "utf8"));
  }
  const { feedUrl: suFeedUrl, publicEdKey: suPublicEDKey } = resolveUpdateConfig({
    config: rawUpdateConfig,
    env: process.env,
  });

  const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const appVersion = rootPkg.version || "0.2.0";

  // Pre-flight check: required desktop scripts must exist before build proceeds.
  checkRequiredScripts(join(root, "desktop"));

  const output = join(root, "dist", "Sumi.app");
  const staging = join(root, "dist/.Sumi-build");
  const stagedApp = join(staging, "Sumi.app");
  const contents = join(stagedApp, "Contents");
  const resources = join(contents, "Resources");
  const frameworks = join(contents, "Frameworks");
  const macos = join(contents, "MacOS");
  const appDir = join(resources, "app");

  const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: "inherit" });

  // 1. Build Next.js production standalone bundle
  run("pnpm", ["build"]);

  // 2. Clean and initialize staging directory
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  const cacheDir = join(root, ".desktop-cache");
  mkdirSync(cacheDir, { recursive: true });

  // 3. Download and extract official Electron archive
  console.log(`Downloading and verifying official Electron v${ELECTRON_VERSION}...`);
  const { archivePath: electronZipPath } = await ensureElectronArchive(cacheDir, process.arch);

  const electronTemp = mkdtempSync(join(tmpdir(), "sumi-electron-"));
  try {
    execFileSync("unzip", ["-q", electronZipPath, "-d", electronTemp]);
    const extractedApp = join(electronTemp, "Electron.app");
    if (!existsSync(extractedApp)) {
      throw new Error("Electron archive did not contain Electron.app");
    }
    renameSync(extractedApp, stagedApp);

    // Preserve Electron licenses
    mkdirSync(join(resources, "licenses"), { recursive: true });
    const electronLicense = join(electronTemp, "LICENSE");
    if (existsSync(electronLicense)) {
      cpSync(electronLicense, join(resources, "licenses/Electron-LICENSE.txt"));
    }
    const chromiumLicense = join(electronTemp, "LICENSES.chromium.html");
    if (existsSync(chromiumLicense)) {
      cpSync(chromiumLicense, join(resources, "licenses/LICENSES.chromium.html"));
    }
  } finally {
    rmSync(electronTemp, { recursive: true, force: true });
  }

  // 4. Clean Electron defaults (both ASAR off) and rename binary
  rmSync(join(resources, "default_app.asar"), { force: true });
  rmSync(join(resources, "electron.icns"), { force: true });
  renameSync(join(macos, "Electron"), join(macos, "Sumi"));

  // 5. Generate and install native application icon via Icon.swift
  const iconTemp = mkdtempSync(join(tmpdir(), "sumi-icon-"));
  try {
    const masterPng = join(iconTemp, "icon_1024x1024.png");
    run("xcrun", [
      "swift",
      "-module-cache-path",
      cacheDir,
      join(root, "desktop/Icon.swift"),
      masterPng,
    ]);
    const iconset = join(iconTemp, "Sumi.iconset");
    mkdirSync(iconset, { recursive: true });
    for (const [size, scale] of [
      [16, 1],
      [16, 2],
      [32, 1],
      [32, 2],
      [128, 1],
      [128, 2],
      [256, 1],
      [256, 2],
      [512, 1],
      [512, 2],
    ]) {
      const px = size * scale;
      const name = `icon_${size}x${size}${scale > 1 ? "@2x" : ""}.png`;
      const dest = join(iconset, name);
      if (px === 1024) cpSync(masterPng, dest);
      else run("sips", ["-z", String(px), String(px), masterPng, "--out", dest]);
    }
    run("iconutil", ["-c", "icns", iconset, "-o", join(resources, "Sumi.icns")]);
  } finally {
    rmSync(iconTemp, { recursive: true, force: true });
  }

  // 6. Assemble Next standalone server and official Node runtime
  mkdirSync(join(resources, "runtime"), { recursive: true });
  cpSync(join(root, "apps/web/.next/standalone"), join(resources, "server"), {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
  });

  const web = join(resources, "server/apps/web");
  const entrypoint = join(web, "server.js");
  const generated = readFileSync(entrypoint, "utf8");
  const portFallback = "parseInt(process.env.PORT, 10) || 3000";
  if (!generated.includes(portFallback)) {
    throw new Error("Next's standalone entrypoint changed; review ephemeral port handling.");
  }
  writeFileSync(
    entrypoint,
    generated.replace(portFallback, `(process.env.PORT === "0" ? 0 : (${portFallback}))`),
  );
  cpSync(join(root, "apps/web/.next/static"), join(web, ".next/static"), { recursive: true });
  cpSync(join(root, "apps/web/public"), join(web, "public"), { recursive: true });

  console.log(`Downloading and verifying official Node runtime (${process.version})...`);
  const { archivePath: nodeArchivePath } = await ensureNodeArchive(
    cacheDir,
    process.version,
    process.arch,
  );
  const nodeTemp = mkdtempSync(join(tmpdir(), "sumi-node-"));
  try {
    run("tar", ["-xzf", nodeArchivePath, "-C", nodeTemp]);
    const runtime = join(nodeTemp, `node-${process.version}-darwin-${process.arch}`);
    cpSync(join(runtime, "bin/node"), join(resources, "runtime/node"));
    cpSync(join(runtime, "LICENSE"), join(resources, "licenses/Node-LICENSE.txt"));
  } finally {
    rmSync(nodeTemp, { recursive: true, force: true });
  }

  cpSync(join(root, "desktop/launch.cjs"), join(resources, "launch.cjs"));
  writeFileSync(
    join(resources, "package.json"),
    JSON.stringify(
      { name: "sumi-desktop", version: appVersion, type: "commonjs", private: true },
      null,
      2,
    ) + "\n",
  );

  cpSync(join(root, "LICENSE"), join(resources, "licenses/Trade-Journal-MIT.txt"));
  cpSync(join(root, "desktop/Kami-LICENSE.txt"), join(resources, "licenses/Kami-MIT.txt"));
  cpSync(
    join(root, "desktop/THIRD-PARTY-NOTICES.md"),
    join(resources, "licenses/THIRD-PARTY-NOTICES.md"),
  );

  // Clean private files from standalone server bundle
  function clean(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (
        entry.name.startsWith(".env") ||
        /\.(db|sqlite)(-shm|-wal|-journal)?$/.test(entry.name) ||
        /\.gguf$/.test(entry.name) ||
        entry.name === ".secret"
      ) {
        rmSync(path, { recursive: true, force: true });
      } else if (entry.isDirectory()) {
        clean(path);
      }
    }
  }
  clean(join(resources, "server"));

  // Bundle ONLY the lightweight MIT-licensed Silero VAD asset (1.2 MB)
  const sileroSrc = join(root, "models/silero-vad-v6.2-F32.gguf");
  const sileroExpectedSha256 = "0d871a800c420fdd5d1b17a3aea4296d1c39608f0ff4a9295eb76457eb1c88e6";
  if (!existsSync(sileroSrc)) {
    throw new Error(`Silero VAD model missing at ${sileroSrc}`);
  }
  const sileroBytes = readFileSync(sileroSrc);
  const sileroHash = createHash("sha256").update(sileroBytes).digest("hex");
  if (sileroHash !== sileroExpectedSha256) {
    throw new Error(
      `Silero VAD checksum mismatch: expected ${sileroExpectedSha256}, got ${sileroHash}`,
    );
  }
  const serverWebModels = join(web, "models");
  mkdirSync(serverWebModels, { recursive: true });
  cpSync(sileroSrc, join(serverWebModels, "silero-vad-v6.2-F32.gguf"));
  const sileroLicenseSrc = join(root, "models/LICENSE.silero_vad");
  if (existsSync(sileroLicenseSrc)) {
    cpSync(sileroLicenseSrc, join(serverWebModels, "LICENSE.silero_vad"));
    cpSync(sileroLicenseSrc, join(resources, "licenses/Silero-VAD-MIT.txt"));
  }

  // Package transcribe-cpp and koffi native dependencies
  const nativeTuple =
    process.platform === "darwin" && process.arch === "arm64" ? "darwin-arm64-metal" : null;
  if (nativeTuple) {
    try {
      const packageDir = realpathSync(join(root, "apps/web/node_modules/transcribe-cpp"));
      const pkgJson = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
      const entryRelative = pkgJson.exports?.["."]?.import || "./dist/index.js";
      const entryPath = join(packageDir, entryRelative);
      const { artifactDir } = await import(pathToFileURL(entryPath).href);
      const nativeSrc = artifactDir();
      const libName = "libtranscribe.dylib";
      if (!existsSync(join(nativeSrc, libName))) {
        throw new Error(`transcribe-cpp native library missing from ${nativeSrc}`);
      }
      for (const nm of [
        join(resources, "server/node_modules"),
        join(resources, "server/apps/web/node_modules"),
      ]) {
        const pkgDest = join(nm, `@transcribe-cpp/${nativeTuple}`);
        if (!existsSync(join(pkgDest, libName))) {
          mkdirSync(pkgDest, { recursive: true });
          cpSync(nativeSrc, pkgDest, { recursive: true, dereference: true });
        }
      }
    } catch (cause) {
      throw new Error(`Cannot package transcribe-cpp native platform binaries: ${cause.message}`, {
        cause,
      });
    }

    const koffiNative = join(
      root,
      "node_modules/.pnpm/@koromix+koffi-darwin-arm64@3.3.7/node_modules/@koromix",
    );
    if (existsSync(koffiNative)) {
      for (const nm of [
        join(resources, "server/node_modules/@koromix"),
        join(resources, "server/apps/web/node_modules/@koromix"),
      ]) {
        if (!existsSync(nm)) {
          mkdirSync(dirname(nm), { recursive: true });
          cpSync(koffiNative, nm, { recursive: true, dereference: true });
        }
      }
    }
  }

  // Verify self-contained symlinks
  const serverBase = realpathSync(join(resources, "server"));
  const serverPrefix = serverBase + "/";
  function assertSelfContained(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = realpathSync(path);
        if (target !== serverBase && !target.startsWith(serverPrefix)) {
          throw new Error(`Symlink escapes application bundle: ${path} -> ${target}`);
        }
      } else if (entry.isDirectory()) {
        assertSelfContained(path);
      }
    }
  }
  assertSelfContained(join(resources, "server"));

  // Collect dependency licenses
  const collected = new Set();
  function collectLicenses(modules) {
    if (!existsSync(modules)) return;
    for (const entry of readdirSync(modules)) {
      if (entry.startsWith(".")) continue;
      const packagePath = join(modules, entry);
      if (entry.startsWith("@")) {
        collectLicenses(packagePath);
        continue;
      }
      if (!existsSync(join(packagePath, "package.json"))) continue;
      let metadata;
      try {
        metadata = JSON.parse(readFileSync(join(packagePath, "package.json"), "utf8"));
      } catch (cause) {
        throw new Error(`Cannot read dependency metadata at ${packagePath}`, { cause });
      }
      const id = `${metadata.name}@${metadata.version}`.replaceAll("/", "__");
      if (collected.has(id)) continue;
      collected.add(id);
      for (const name of readdirSync(packagePath).filter((name) =>
        /^(licen[sc]e|copying|notice)(\.|$)/i.test(name),
      )) {
        const destination = join(resources, "licenses/dependencies", id);
        mkdirSync(destination, { recursive: true });
        cpSync(join(packagePath, name), join(destination, name), { recursive: true });
      }
    }
  }
  for (const entry of readdirSync(join(root, "node_modules/.pnpm"))) {
    collectLicenses(join(root, "node_modules/.pnpm", entry, "node_modules"));
  }

  // 7. Assemble Electron Application Entry in Contents/Resources/app (unpacked ASAR off)
  mkdirSync(appDir, { recursive: true });
  writeFileSync(
    join(appDir, "package.json"),
    JSON.stringify(
      {
        name: "sumi-desktop",
        version: appVersion,
        main: "main.cjs",
        private: true,
        type: "commonjs",
      },
      null,
      2,
    ) + "\n",
  );

  for (const script of REQUIRED_DESKTOP_SCRIPTS) {
    const src = join(root, "desktop", script);
    cpSync(src, join(appDir, script));
  }

  // 8. Sparkle Integration: Native framework + bindings + runtime JS
  const sparklePkgPath = join(root, "node_modules/electron-sparkle");
  if (existsSync(sparklePkgPath)) {
    try {
      console.log("Materializing and bundling Sparkle updater assets...");
      const { materializeDarwinDistribution } = await import(
        pathToFileURL(join(sparklePkgPath, "dist/artifacts-C_Z5iSIA.cjs")).href
      );
      const sparkleDist = await materializeDarwinDistribution({
        architecture: process.arch === "arm64" ? "arm64" : "x64",
      });

      // Install Sparkle.framework and electron_sparkle.node into Frameworks
      const frameworkDest = join(frameworks, "Sparkle.framework");
      const addonDest = join(frameworks, "electron_sparkle.node");
      cpSync(sparkleDist.frameworkPath, frameworkDest, {
        recursive: true,
        dereference: false,
        verbatimSymlinks: true,
      });
      cpSync(sparkleDist.addonPath, addonDest, {
        dereference: false,
        verbatimSymlinks: true,
      });

      // Confine Sparkle framework symlinks
      assertFrameworkSymlinksConfined(frameworkDest);

      // Install Sparkle licenses & marker
      const thirdPartyLicenses = join(resources, "ThirdPartyLicenses");
      mkdirSync(thirdPartyLicenses, { recursive: true });
      cpSync(sparkleDist.licensePath, join(thirdPartyLicenses, "Sparkle-LICENSE.txt"));
      cpSync(sparkleDist.licensePath, join(resources, "licenses/Sparkle-LICENSE.txt"));

      writeFileSync(
        join(resources, ".electron-sparkle.json"),
        JSON.stringify(
          {
            schemaVersion: 1,
            packageName: "electron-sparkle",
            packageVersion: "0.2.0",
            sparkleVersion: "2.9.6",
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );

      // Copy runtime electron-sparkle and plist dependencies into app/node_modules
      const appNodeModules = join(appDir, "node_modules");
      mkdirSync(appNodeModules, { recursive: true });
      const sparkleReal = realpathSync(sparklePkgPath);
      cpSync(sparkleReal, join(appNodeModules, "electron-sparkle"), {
        recursive: true,
        dereference: true,
      });

      // Copy plist dependency
      const pnpmDir = join(root, "node_modules/.pnpm");
      if (existsSync(pnpmDir)) {
        for (const entry of readdirSync(pnpmDir)) {
          if (entry.startsWith("plist@")) {
            const plistModules = join(pnpmDir, entry, "node_modules");
            if (existsSync(plistModules)) {
              for (const mod of readdirSync(plistModules)) {
                const srcMod = join(plistModules, mod);
                const destMod = join(appNodeModules, mod);
                if (!existsSync(destMod)) {
                  cpSync(srcMod, destMod, { recursive: true, dereference: true });
                }
              }
            }
          }
        }
      }
    } catch (err) {
      throw new Error(`Failed to bundle Sparkle updater assets: ${err.message}`, { cause: err });
    }
  }

  // 9. Update Info.plist files
  // suFeedUrl / suPublicEDKey were already resolved AND validated pre-flight;
  // buildInfoPlist re-validates and always emits SUPublicEDKey.
  writeFileSync(
    join(contents, "Info.plist"),
    buildInfoPlist(appVersion, {
      suFeedUrl,
      suPublicEDKey,
      minSystemVersion: LS_MINIMUM_SYSTEM_VERSION,
    }),
  );

  // Update Helper Info.plists
  const helpers = [
    { dir: "Electron Helper.app", id: "local.sumi.journal.helper", name: "Electron Helper" },
    {
      dir: "Electron Helper (GPU).app",
      id: "local.sumi.journal.helper.gpu",
      name: "Electron Helper (GPU)",
    },
    {
      dir: "Electron Helper (Plugin).app",
      id: "local.sumi.journal.helper.plugin",
      name: "Electron Helper (Plugin)",
    },
    {
      dir: "Electron Helper (Renderer).app",
      id: "local.sumi.journal.helper.renderer",
      name: "Electron Helper (Renderer)",
    },
  ];

  for (const h of helpers) {
    const helperPlist = join(frameworks, h.dir, "Contents/Info.plist");
    if (existsSync(helperPlist)) {
      writeFileSync(helperPlist, buildHelperInfoPlist(h.id, h.name, appVersion));
    }
  }

  const frameworkPlist = join(
    frameworks,
    "Electron Framework.framework/Versions/A/Resources/Info.plist",
  );
  if (existsSync(frameworkPlist)) {
    // The Electron Framework is VENDOR metadata: stamp the pinned Electron
    // version (45.2.3), NOT the root app version (0.2.0). App/helper plists
    // above keep the app version.
    writeFileSync(frameworkPlist, buildFrameworkInfoPlist(ELECTRON_VERSION));
  }

  // 10. Hardened Runtime Ad-Hoc Code Signing
  const entitlementsPath = join(cacheDir, "entitlements.mac.plist");
  writeFileSync(entitlementsPath, buildEntitlementsXml(), "utf8");

  function signItem(itemPath, entitlements = null) {
    if (!existsSync(itemPath)) return;
    const args = ["--force", "--sign", "-"];
    if (entitlements && existsSync(entitlements)) {
      args.push("--entitlements", entitlements);
    }
    args.push(itemPath);
    run("codesign", args);
  }

  // Sign Framework internals
  const efVersionsA = join(frameworks, "Electron Framework.framework/Versions/A");
  signItem(join(efVersionsA, "Libraries/libffmpeg.dylib"));
  signItem(join(efVersionsA, "Libraries/libvk_swiftshader.dylib"));
  signItem(join(efVersionsA, "Helpers/app_shim_loader"));
  signItem(join(efVersionsA, "Helpers/chrome_crashpad_handler"));
  signItem(join(frameworks, "Electron Framework.framework"));
  signItem(join(frameworks, "Mantle.framework"));
  signItem(join(frameworks, "ReactiveObjC.framework"));
  signItem(join(frameworks, "Squirrel.framework"));

  // Sign Sparkle internals if present
  const sparkleFramework = join(frameworks, "Sparkle.framework");
  if (existsSync(sparkleFramework)) {
    signItem(join(frameworks, "electron_sparkle.node"));
    signItem(join(sparkleFramework, "Versions/B/Autoupdate"));
    signItem(join(sparkleFramework, "Versions/B/Updater.app"));
    signItem(sparkleFramework);
  }

  // Sign Helpers
  for (const h of helpers) {
    signItem(join(frameworks, h.dir), entitlementsPath);
  }

  // Sign Resources runtime and binaries
  signItem(join(resources, "runtime/node"));
  function signBinaries(directory) {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const p = join(directory, entry.name);
      if (entry.isDirectory()) {
        signBinaries(p);
      } else if (/\.(dylib|node)$/.test(entry.name)) {
        signItem(p);
      }
    }
  }
  signBinaries(join(resources, "server"));

  // Top-level staged app signing with entitlements
  run("codesign", [
    "--force",
    "--deep",
    "--sign",
    "-",
    "--entitlements",
    entitlementsPath,
    stagedApp,
  ]);
  run("codesign", ["--verify", "--deep", "--strict", stagedApp]);

  // 11. Atomic swap: replace dist/Sumi.app only after complete staging success
  rmSync(output, { recursive: true, force: true });
  renameSync(stagedApp, output);
  rmSync(staging, { recursive: true, force: true });

  console.log(
    `\nBuilt ${output} (v${appVersion}, Electron v${ELECTRON_VERSION})\nRun: open "${output}"`,
  );
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirectRun) {
  await build();
}
