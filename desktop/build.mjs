import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path, { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ELECTRON_VERSION = "45.2.3";

// Verified official Electron v45.2.3 asset SHA-256 hashes
export const PINNED_ELECTRON_CHECKSUMS = {
  "darwin-arm64": "4d7c429064087a47b855d9bd06c76ead4819b7f02b385de232d4a5c37ecef55f",
  "darwin-x64": "d87323533cc8750ef177e5b48058f7a8b381f677d4e103cc63360006c08829c2",
  "linux-x64": "a87fe741f6d121285117e574da6c9a2e65210d410123bbc04713b099add0263b",
  "linux-arm64": "397c060fd9da99ab72b78787d65545b432fcadf13ef6c96658e4f525692aae0f",
  "win32-x64": "489cd061908e697394b004298bf5ffd345c935d10e8ca197ba819f019ab2dec0",
  "win32-arm64": "f664bd7a4adfc45ac237a6f5fbf6c8e041b71b174466e9cb6fc9416c918e249d",
};

export const SUPPORTED_PLATFORMS = ["darwin", "linux", "win32"];

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
  "update-service-platform.cjs",
];

export const DEFAULT_FEED_URL =
  "https://github.com/xolah88457/trade-journal/releases/latest/download/appcast.xml";
export const DEFAULT_X64_FEED_URL =
  "https://github.com/xolah88457/trade-journal/releases/latest/download/appcast-x64.xml";

export const APP_UPDATE_CONFIG = Object.freeze({
  owner: "xolah88457",
  repo: "trade-journal",
  provider: "github",
  updaterCacheDirName: "sumi-updater",
});

/**
 * Generates the canonical app-update.yml content for electron-updater on Windows and Linux.
 */
export function generateAppUpdateYaml(config = APP_UPDATE_CONFIG) {
  return (
    `owner: ${config.owner}\n` +
    `repo: ${config.repo}\n` +
    `provider: ${config.provider}\n` +
    `updaterCacheDirName: ${config.updaterCacheDirName}\n`
  );
}

export const SILERO_EXPECTED_SHA256 =
  "0d871a800c420fdd5d1b17a3aea4296d1c39608f0ff4a9295eb76457eb1c88e6";

export const REQUIRED_WIN32_CRT_DLLS = ["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"];

/**
 * Resolves the location of app-local Visual C++ 14.x x64 CRT DLLs on Windows.
 * Prefers the official Microsoft Visual C++ Redistributable directory
 * (via vswhere or VCToolsRedistDir), or falls back to system32 if necessary.
 */
export function resolveWindowsCrtDlls(options = {}) {
  const env = options.env || process.env;
  const candidates = [];

  // 1. Explicit environment override
  if (env.VC_REDIST_X64_DIR && existsSync(env.VC_REDIST_X64_DIR)) {
    candidates.push(env.VC_REDIST_X64_DIR);
  }

  // 2. VCToolsRedistDir environment variable (set in VS command prompts)
  if (env.VCToolsRedistDir) {
    const vcDir = join(env.VCToolsRedistDir, "x64");
    if (existsSync(vcDir)) {
      try {
        for (const entry of readdirSync(vcDir)) {
          if (/^Microsoft\.VC\d+\.CRT$/i.test(entry)) {
            candidates.push(join(vcDir, entry));
          }
        }
      } catch {}
    }
  }

  // 3. Probe vswhere if available on Windows
  if (process.platform === "win32") {
    try {
      const vswhere = join(
        env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
        "Microsoft Visual Studio",
        "Installer",
        "vswhere.exe",
      );
      if (existsSync(vswhere)) {
        const found = execFileSync(
          vswhere,
          ["-latest", "-products", "*", "-find", "VC/Redist/MSVC/**/x64/Microsoft.VC*.CRT"],
          { encoding: "utf8" },
        )
          .trim()
          .split(/\r?\n/)
          .filter(Boolean);
        candidates.push(...found);
      }
    } catch {
      // vswhere not found or failed
    }
  }

  // 4. Common Visual Studio / Build Tools paths on C:\
  const programFiles = [
    env["ProgramFiles"] || "C:\\Program Files",
    env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
  ];
  for (const pf of programFiles) {
    for (const edition of ["Enterprise", "Professional", "Community", "BuildTools"]) {
      for (const year of ["2022", "2019"]) {
        const redistBase = join(
          pf,
          "Microsoft Visual Studio",
          year,
          edition,
          "VC",
          "Redist",
          "MSVC",
        );
        if (existsSync(redistBase)) {
          try {
            for (const ver of readdirSync(redistBase)) {
              const crtDir = join(redistBase, ver, "x64");
              if (existsSync(crtDir)) {
                for (const entry of readdirSync(crtDir)) {
                  if (/^Microsoft\.VC\d+\.CRT$/i.test(entry)) {
                    candidates.push(join(crtDir, entry));
                  }
                }
              }
            }
          } catch {}
        }
      }
    }
  }

  // 5. System32 fallback
  const sys32 = join(env["SystemRoot"] || env["WINDIR"] || "C:\\Windows", "System32");
  if (existsSync(sys32)) {
    candidates.push(sys32);
  }

  // Search candidates for the required DLLs
  const resolved = {};
  for (const dll of REQUIRED_WIN32_CRT_DLLS) {
    for (const dir of candidates) {
      const fullPath = join(dir, dll);
      if (existsSync(fullPath)) {
        resolved[dll] = fullPath;
        break;
      }
      try {
        const entries = readdirSync(dir);
        const match = entries.find((e) => e.toLowerCase() === dll.toLowerCase());
        if (match) {
          resolved[dll] = join(dir, match);
          break;
        }
      } catch {}
    }
  }

  return resolved;
}

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
 * Resolves the Mac architecture feed URL split.
 * ARM keeps canonical appcast.xml (v0.2 clients already use it);
 * Intel (x64) uses appcast-x64.xml.
 */
export function resolveMacFeedUrl(baseFeedUrl, arch = process.arch) {
  if (arch === "x64") {
    if (baseFeedUrl.endsWith("/appcast.xml")) {
      return baseFeedUrl.replace(/\/appcast\.xml$/, "/appcast-x64.xml");
    }
  }
  return baseFeedUrl;
}

/**
 * Resolves and validates the canonical update configuration.
 *
 * Canonical source is desktop/update-config.json ({ feedUrl, publicEdKey });
 * environment overrides (SUMI_FEED_URL / SUFeedURL, SUMI_PUBLIC_ED_KEY / SUPublicEDKey)
 * take precedence when set. feedUrl defaults to DEFAULT_FEED_URL (or DEFAULT_X64_FEED_URL for x64).
 *
 * Empty or invalid publicEdKey MUST THROW - SUPublicEDKey is never omitted.
 * This MUST run before any Next build / download / staging / replacement step,
 * so an unreleasable config fails the build immediately and loudly.
 */
export function resolveUpdateConfig({ config = {}, env = process.env, arch = process.arch } = {}) {
  let feedUrl = env.SUMI_FEED_URL || env.SUFeedURL || config.feedUrl || "";
  let publicEdKey = env.SUMI_PUBLIC_ED_KEY || env.SUPublicEDKey || config.publicEdKey || "";
  if (!feedUrl) {
    feedUrl = arch === "x64" ? DEFAULT_X64_FEED_URL : DEFAULT_FEED_URL;
  } else if (
    arch === "x64" &&
    feedUrl.endsWith("/appcast.xml") &&
    !env.SUMI_FEED_URL &&
    !env.SUFeedURL
  ) {
    feedUrl = resolveMacFeedUrl(feedUrl, "x64");
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

/**
 * Checks whether targetPath is strictly inside baseDir (or equals baseDir).
 * Fully platform-aware: handles Windows backslashes, drive roots, UNC paths, and case-insensitivity.
 */
export function isPathContained(baseDir, targetPath, platform = process.platform) {
  const normBase = platform === "win32" ? baseDir.toLowerCase() : baseDir;
  const normTarget = platform === "win32" ? targetPath.toLowerCase() : targetPath;
  const pathMod = platform === "win32" ? path.win32 : path.posix;
  const rel = pathMod.relative(normBase, normTarget);
  return rel === "" || (!rel.startsWith("..") && !pathMod.isAbsolute(rel));
}

export function assertFrameworkSymlinksConfined(frameworkPath) {
  if (!existsSync(frameworkPath)) return;
  const realBase = realpathSync(frameworkPath);
  function check(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const real = realpathSync(p);
        if (!isPathContained(realBase, real)) {
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

export function getElectronArchiveName(
  version = ELECTRON_VERSION,
  platform = process.platform,
  arch = process.arch,
) {
  const normArch = arch === "arm64" ? "arm64" : "x64";
  const plat = platform === "win32" ? "win32" : platform === "darwin" ? "darwin" : "linux";
  return `electron-v${version}-${plat}-${normArch}.zip`;
}

export async function ensureElectronArchive(
  cacheDir,
  arch = process.arch,
  platform = process.platform,
) {
  mkdirSync(cacheDir, { recursive: true });
  const normArch = arch === "arm64" ? "arm64" : "x64";
  const platformKey = `${platform === "win32" ? "win32" : platform}-${normArch}`;
  const archiveName = getElectronArchiveName(ELECTRON_VERSION, platform, arch);
  const base = `https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}`;
  const archivePath = join(cacheDir, archiveName);
  const sumsPath = join(cacheDir, `electron-v${ELECTRON_VERSION}-SHASUMS256.txt`);

  const pinnedSha = PINNED_ELECTRON_CHECKSUMS[platformKey];

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

export function getNodeArchiveName(
  runtimeVersion = process.version,
  platform = process.platform,
  arch = process.arch,
) {
  const normArch = arch === "arm64" ? "arm64" : "x64";
  if (platform === "win32") {
    return `node-${runtimeVersion}-win-${normArch}.zip`;
  }
  return `node-${runtimeVersion}-${platform}-${normArch}.tar.gz`;
}

export function getNodeBinaryRelativePath(platform = process.platform) {
  return platform === "win32" ? "node.exe" : "bin/node";
}

export async function ensureNodeArchive(
  cacheDir,
  runtimeVersion = process.version,
  arch = process.arch,
  platform = process.platform,
) {
  mkdirSync(cacheDir, { recursive: true });
  const archiveName = getNodeArchiveName(runtimeVersion, platform, arch);
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

/**
 * Resolves the verified transcribe-cpp native platform tuple.
 */
export function getNativeTuple(platform = process.platform, arch = process.arch) {
  const normArch = arch === "arm64" ? "arm64" : "x64";
  if (platform === "darwin") {
    return normArch === "arm64" ? "darwin-arm64-metal" : "darwin-x64-cpu";
  }
  if (platform === "linux") {
    return normArch === "arm64" ? "linux-arm64-cpu-vulkan" : "linux-x64-cpu-vulkan";
  }
  if (platform === "win32") {
    return normArch === "x64" ? "win32-x64-cpu-vulkan" : null;
  }
  return null;
}

export function getNativeLibName(platform = process.platform) {
  if (platform === "darwin") return "libtranscribe.dylib";
  if (platform === "win32") return "transcribe.dll";
  return "libtranscribe.so";
}

export function getKoffiPackageName(platform = process.platform, arch = process.arch) {
  const normArch = arch === "arm64" ? "arm64" : "x64";
  return `@koromix/koffi-${platform}-${normArch}`;
}

/**
 * Resolves the installed @koromix/koffi-${platform}-${arch} package directory from installed metadata.
 */
export function resolveKoffiPackageDir(root, platform = process.platform, arch = process.arch) {
  const normArch = arch === "arm64" ? "arm64" : "x64";
  const pkgName = `koffi-${platform}-${normArch}`;

  // 1. Try resolving via Node's createRequire from apps/web or root
  for (const start of [join(root, "apps/web/package.json"), join(root, "package.json")]) {
    if (existsSync(start)) {
      try {
        const req = createRequire(start);
        const resolvedPath = req.resolve(`@koromix/${pkgName}/package.json`);
        const pkgDir = dirname(resolvedPath);
        if (existsSync(pkgDir)) {
          return pkgDir;
        }
      } catch {
        try {
          const req = createRequire(start);
          const entry = req.resolve(`@koromix/${pkgName}`);
          const found = findOwningPackageJson(entry);
          if (found && existsSync(found.pkgDir)) {
            return found.pkgDir;
          }
        } catch {}
      }
    }
  }

  // 2. Scan node_modules/.pnpm for the package directory matching the target package
  const pnpmDir = join(root, "node_modules/.pnpm");
  if (existsSync(pnpmDir)) {
    const pattern = `@koromix+${pkgName}@`;
    for (const entry of readdirSync(pnpmDir)) {
      if (entry.startsWith(pattern)) {
        const candidate = join(pnpmDir, entry, "node_modules/@koromix", pkgName);
        if (existsSync(candidate)) {
          return candidate;
        }
      }
    }
  }

  return null;
}

/**
 * Resolves the installed @koromix native directory for Koffi from actual installed metadata.
 */
export function resolveKoffiNativeDir(root, platform = process.platform, arch = process.arch) {
  const pkgDir = resolveKoffiPackageDir(root, platform, arch);
  return pkgDir ? dirname(pkgDir) : null;
}

/**
 * Asserts that the Koffi native binary payload (.node) exists in the staged server bundle.
 */
export function assertKoffiPayload(serverDir, platform = process.platform, arch = process.arch) {
  const normArch = arch === "arm64" ? "arm64" : "x64";
  const binarySubpath = `${platform}_${normArch}/koffi.node`;
  const pkgSubpath = `@koromix/koffi-${platform}-${normArch}`;

  const candidates = [
    join(serverDir, "node_modules", pkgSubpath, binarySubpath),
    join(serverDir, "apps/web/node_modules", pkgSubpath, binarySubpath),
  ];

  const pnpmDir = join(serverDir, "node_modules/.pnpm");
  if (existsSync(pnpmDir)) {
    for (const entry of readdirSync(pnpmDir)) {
      if (entry.includes(`koffi-${platform}-${normArch}`)) {
        candidates.push(join(pnpmDir, entry, "node_modules", pkgSubpath, binarySubpath));
      }
    }
  }

  const existing = candidates.filter((c) => existsSync(c));
  if (existing.length === 0) {
    throw new Error(
      `Koffi native binary payload missing: ${binarySubpath} not found under ${pkgSubpath} in ${serverDir}`,
    );
  }
  return existing;
}

/**
 * Locates the owning package.json for an entrypoint file by walking up directories.
 * Fallback for packages whose "exports" map hides ./package.json.
 */
export function findOwningPackageJson(entryPath) {
  let dir = dirname(entryPath);
  while (dir && dir !== dirname(dir)) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const json = JSON.parse(readFileSync(pkgPath, "utf8"));
        return { pkgPath, pkgDir: dir, json };
      } catch {}
    }
    dir = dirname(dir);
  }
  return null;
}

/**
 * Resolves a package's directory and metadata from a starting directory.
 * Tries direct package.json subpath first; if hidden by exports (e.g. fs-extra),
 * resolves the entrypoint and walks up to the owning package.json.
 * Throws loudly if the required dependency is missing.
 */
export function resolvePackage(pkgName, startDir) {
  const req = createRequire(
    existsSync(join(startDir, "package.json"))
      ? join(startDir, "package.json")
      : join(startDir, "dummy.js"),
  );

  // 1. Try direct package.json subpath
  try {
    const pkgPath = req.resolve(`${pkgName}/package.json`);
    const json = JSON.parse(readFileSync(pkgPath, "utf8"));
    return { pkgPath, pkgDir: dirname(pkgPath), json };
  } catch (err) {
    // 2. Try entrypoint then find owning package.json
    try {
      const entryPath = req.resolve(pkgName);
      const found = findOwningPackageJson(entryPath);
      if (found) return found;
    } catch (e2) {}
  }

  throw new Error(`Required runtime dependency missing: ${pkgName} (required from ${startDir})`);
}

/**
 * Bundles a package and its production dependencies with version-aware hoisting and nesting.
 * If conflicting versions of a transitive dependency are encountered, nests the dependency
 * in the requiring package's local node_modules directory rather than overwriting or skipping it.
 * Bounded recursion prevents infinite cycles on circular dependencies.
 */
export function bundlePackageWithRuntimeDeps(pkgName, startDir, targetNodeModules) {
  const topInstalled = new Map(); // packageName -> version

  function bundle(name, fromDir, currentTargetModules, stack = new Set()) {
    const { pkgDir, json } = resolvePackage(name, fromDir);
    const pkgId = `${json.name}@${json.version}`;
    if (stack.has(pkgId)) return; // Bounded cycle prevention
    const nextStack = new Set(stack);
    nextStack.add(pkgId);

    let destDir;
    let nextTargetModules;

    if (!topInstalled.has(json.name)) {
      // First time seeing this package: install at top level
      destDir = join(targetNodeModules, json.name);
      topInstalled.set(json.name, json.version);
      nextTargetModules = targetNodeModules;
    } else if (topInstalled.get(json.name) === json.version) {
      // Already installed at top level with identical version
      destDir = join(targetNodeModules, json.name);
      nextTargetModules = targetNodeModules;
    } else {
      // Version conflict: nest inside the requiring package's node_modules
      destDir = join(currentTargetModules, json.name);
      nextTargetModules = join(destDir, "node_modules");
    }

    if (!existsSync(destDir)) {
      mkdirSync(dirname(destDir), { recursive: true });
      cpSync(pkgDir, destDir, { recursive: true, dereference: true });
    }

    const deps = Object.keys(json.dependencies || {});
    for (const dep of deps) {
      const depTargetModules = join(destDir, "node_modules");
      bundle(dep, pkgDir, depTargetModules, nextStack);
    }
  }

  bundle(pkgName, startDir, targetNodeModules);
}

/**
 * Copies Next.js standalone server directory for Windows without invoking cpSync({ dereference: true })
 * on Next.js 15 symlinks. Next.js creates symlinks using fs.promises.symlink() without the 'dir'/'junction'
 * type argument, causing Windows NTFS to create file-type reparse points for directories that throw
 * EPERM on fs.stat(). Resolves link targets via readlink/realpath/installed package roots, and copies
 * the actual resolved package directory tree dereferenced.
 */
export function copyStandaloneForWindows(standaloneSrc, serverDest, root) {
  function copyRecursive(srcDir, destDir, ancestors = new Set()) {
    mkdirSync(destDir, { recursive: true });
    for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
      const srcPath = join(srcDir, entry.name);
      const destPath = join(destDir, entry.name);

      if (entry.isSymbolicLink()) {
        let resolvedTarget = null;

        // 1. Read the symlink target string and resolve relative to link parent
        try {
          const rawLink = readlinkSync(srcPath);
          const candidate = resolve(srcDir, rawLink);
          if (existsSync(candidate)) {
            resolvedTarget = candidate;
          }
        } catch {
          resolvedTarget = null;
        }

        // 2. Try realpathSync fallback
        if (!resolvedTarget) {
          try {
            const real = realpathSync(srcPath);
            if (existsSync(real)) {
              resolvedTarget = real;
            }
          } catch {
            resolvedTarget = null;
          }
        }

        // 3. Known installed package roots fallback (apps/web or root package.json)
        if (!resolvedTarget) {
          const pkgName = entry.name;
          for (const start of [join(root, "apps/web/package.json"), join(root, "package.json")]) {
            if (existsSync(start)) {
              try {
                const req = createRequire(start);
                const entryFile = req.resolve(pkgName);
                const found = findOwningPackageJson(entryFile);
                if (found && existsSync(found.pkgDir)) {
                  resolvedTarget = found.pkgDir;
                  break;
                }
              } catch {}
            }
          }
        }

        // Fail closed immediately on unresolved dangling link
        if (!resolvedTarget || !existsSync(resolvedTarget)) {
          const relPath = relative(standaloneSrc, srcPath);
          throw new Error(
            `Failed to resolve standalone link target for ${relPath} (link: ${srcPath})`,
          );
        }

        // Cycle ancestor fail-fast check
        if (ancestors.has(resolvedTarget)) {
          throw new Error(
            `Circular link detected in standalone bundle: ${srcPath} -> ${resolvedTarget}`,
          );
        }
        const nextAncestors = new Set(ancestors);
        nextAncestors.add(resolvedTarget);

        // Copy directory via own copyRecursive rather than blind cpSync; preserve file copy
        const targetStat = lstatSync(resolvedTarget);
        if (targetStat.isDirectory()) {
          copyRecursive(resolvedTarget, destPath, nextAncestors);
        } else {
          copyFileSync(resolvedTarget, destPath);
        }
      } else if (entry.isDirectory()) {
        copyRecursive(srcPath, destPath, ancestors);
      } else {
        copyFileSync(srcPath, destPath);
      }
    }
  }

  copyRecursive(standaloneSrc, serverDest);
}

/**
 * Augments a staged Next standalone server bundle with genuine portable runtime dependencies.
 * Resolves traced packages from the pnpm store and hoists them so that Next.js sibling dependencies
 * (such as styled-jsx, @next/env, @swc/helpers) resolve cleanly in environments where symlinks
 * are dereferenced or where NTFS junctions cannot reference the checkout.
 */
export function augmentStandaloneDependencies(serverDir) {
  const pnpmDir = join(serverDir, "node_modules", ".pnpm");
  if (!existsSync(pnpmDir)) return;

  const targets = [join(serverDir, "node_modules"), join(serverDir, "apps/web/node_modules")];

  for (const entry of readdirSync(pnpmDir)) {
    const modulesDir = join(pnpmDir, entry, "node_modules");
    if (!existsSync(modulesDir)) continue;

    for (const item of readdirSync(modulesDir)) {
      if (item.startsWith(".")) continue;
      const itemPath = join(modulesDir, item);
      if (item.startsWith("@")) {
        for (const subItem of readdirSync(itemPath)) {
          const subPath = join(itemPath, subItem);
          const pkgName = `${item}/${subItem}`;
          for (const target of targets) {
            const dest = join(target, pkgName);
            if (!existsSync(dest)) {
              mkdirSync(dirname(dest), { recursive: true });
              cpSync(subPath, dest, { recursive: true, dereference: true });
            }
          }
        }
      } else {
        for (const target of targets) {
          const dest = join(target, item);
          if (!existsSync(dest)) {
            mkdirSync(dirname(dest), { recursive: true });
            cpSync(itemPath, dest, { recursive: true, dereference: true });
          }
        }
      }
    }
  }
}

/**
 * Removes sensitive and environment files from a distribution directory.
 */
export function cleanPrivateFiles(directory) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const p = join(directory, entry.name);
    if (
      entry.name.startsWith(".env") ||
      /\.(db|sqlite)(-shm|-wal|-journal)?$/.test(entry.name) ||
      (entry.name.endsWith(".gguf") && entry.name !== "silero-vad-v6.2-F32.gguf") ||
      entry.name === ".secret"
    ) {
      rmSync(p, { recursive: true, force: true });
    } else if (entry.isDirectory()) {
      cleanPrivateFiles(p);
    }
  }
}

/**
 * Resolves the platform-safe command and arguments for invoking pnpm.
 * On Windows, dispatches via ComSpec cmd.exe /d /s /c "pnpm build" or validated
 * Node + npm_execpath to avoid ENOENT/EINVAL and Node batch file security restrictions.
 */
export function getPnpmCommand(args = [], env = process.env, platform = process.platform) {
  // 1. If npm_execpath points to a validated JS script, invoke directly with current Node binary
  if (env.npm_execpath && existsSync(env.npm_execpath) && /\.[cm]?js$/i.test(env.npm_execpath)) {
    return {
      command: process.execPath,
      args: [env.npm_execpath, ...args],
      options: {},
    };
  }

  // 2. On Windows, dispatch via ComSpec cmd.exe /d /s /c without arbitrary shell argument concatenation
  if (platform === "win32") {
    const comSpec = env.ComSpec || env.COMSPEC || "cmd.exe";
    return {
      command: comSpec,
      args: ["/d", "/s", "/c", ["pnpm", ...args].join(" ")],
      options: { windowsVerbatimArguments: true },
    };
  }

  // 3. Unix standard dispatch
  return {
    command: "pnpm",
    args,
    options: {},
  };
}

/**
 * Verifies that symlinks within a directory do not escape the application bundle.
 */
export function assertSelfContained(directory, serverBase) {
  const canonicalBase = realpathSync(serverBase);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const p = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const target = realpathSync(p);
      if (!isPathContained(canonicalBase, target)) {
        throw new Error(`Symlink escapes application bundle: ${p} -> ${target}`);
      }
    } else if (entry.isDirectory()) {
      assertSelfContained(p, canonicalBase);
    }
  }
}

/**
 * Cross-platform desktop build pipeline for Sumi.
 * Builds macOS (.app), Linux, and Windows desktop distributions on their native host.
 */
export async function build(options = {}) {
  const root = options.root || resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const normArch = arch === "arm64" ? "arm64" : "x64";

  if (!SUPPORTED_PLATFORMS.includes(platform)) {
    throw new Error(
      `Unsupported desktop build platform: ${platform}. Supported: ${SUPPORTED_PLATFORMS.join(", ")}`,
    );
  }

  // Pre-flight 1: on macOS, update config MUST be valid BEFORE any build step.
  const updateConfigPath = join(root, "desktop/update-config.json");
  let rawUpdateConfig = {};
  if (existsSync(updateConfigPath)) {
    rawUpdateConfig = JSON.parse(readFileSync(updateConfigPath, "utf8"));
  }

  let suFeedUrl = "";
  let suPublicEDKey = "";
  if (platform === "darwin") {
    const resolved = resolveUpdateConfig({
      config: rawUpdateConfig,
      env: process.env,
      arch: normArch,
    });
    suFeedUrl = resolved.feedUrl;
    suPublicEDKey = resolved.publicEdKey;
  }

  const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const appVersion = rootPkg.version || "0.3.0";

  // Pre-flight 2: check required desktop scripts
  checkRequiredScripts(join(root, "desktop"));

  const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: "inherit" });
  const runPnpm = (args) => {
    const dispatch = getPnpmCommand(args, process.env, platform);
    return execFileSync(dispatch.command, dispatch.args, {
      cwd: root,
      stdio: "inherit",
      ...dispatch.options,
    });
  };

  // 1. Build Next.js production standalone bundle
  if (!options.skipNextBuild) {
    runPnpm(["build"]);
  }

  const cacheDir = join(root, ".desktop-cache");
  mkdirSync(cacheDir, { recursive: true });

  // 2. Setup staging layout per platform
  let output;
  let staging;
  let stagedApp;
  let resources;
  let appDir;
  let binDir;

  if (platform === "darwin") {
    output = join(root, "dist", "Sumi.app");
    staging = join(root, "dist", ".Sumi-build");
    stagedApp = join(staging, "Sumi.app");
    const contents = join(stagedApp, "Contents");
    resources = join(contents, "Resources");
    binDir = join(contents, "MacOS");
    appDir = join(resources, "app");
  } else if (platform === "win32") {
    output = join(root, "dist", `sumi-win32-${normArch}`);
    staging = join(root, "dist", `.sumi-win-build-${normArch}`);
    stagedApp = staging;
    resources = join(staging, "resources");
    binDir = staging;
    appDir = join(resources, "app");
  } else if (platform === "linux") {
    output = join(root, "dist", `sumi-linux-${normArch}`);
    staging = join(root, "dist", `.sumi-linux-build-${normArch}`);
    stagedApp = staging;
    resources = join(staging, "resources");
    binDir = staging;
    appDir = join(resources, "app");
  }

  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  // 3. Download and extract official Electron archive
  console.log(
    `Downloading and verifying official Electron v${ELECTRON_VERSION} for ${platform}-${normArch}...`,
  );
  const { archivePath: electronZipPath } = await ensureElectronArchive(
    cacheDir,
    normArch,
    platform,
  );

  const electronTemp = mkdtempSync(join(tmpdir(), "sumi-electron-"));
  try {
    execFileSync("unzip", ["-q", electronZipPath, "-d", electronTemp]);

    if (platform === "darwin") {
      const extractedApp = join(electronTemp, "Electron.app");
      if (!existsSync(extractedApp)) {
        throw new Error("Electron archive did not contain Electron.app");
      }
      renameSync(extractedApp, stagedApp);
    } else {
      // Copy all extracted Electron files into staged directory
      cpSync(electronTemp, stagedApp, { recursive: true });
    }

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

  // 4. Clean Electron defaults (unpacked ASAR off) and rename binary
  rmSync(join(resources, "default_app.asar"), { force: true });

  if (platform === "darwin") {
    rmSync(join(resources, "electron.icns"), { force: true });
    renameSync(join(binDir, "Electron"), join(binDir, "Sumi"));
  } else if (platform === "win32") {
    const electronExe = join(stagedApp, "electron.exe");
    if (existsSync(electronExe)) {
      renameSync(electronExe, join(stagedApp, "Sumi.exe"));
    }
  } else if (platform === "linux") {
    const electronBin = join(stagedApp, "electron");
    if (existsSync(electronBin)) {
      renameSync(electronBin, join(stagedApp, "sumi"));
    }
    // Verify chrome-sandbox permissions on Linux
    const sandboxPath = join(stagedApp, "chrome-sandbox");
    if (existsSync(sandboxPath)) {
      try {
        chmodSync(sandboxPath, 0o4755);
      } catch {
        // Running as non-root during build: ensure at least executable
        chmodSync(sandboxPath, 0o755);
      }
    }
  }

  // 5. Generate and install native application icon via Icon.swift (macOS only)
  if (platform === "darwin") {
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
  }

  // 6. Assemble Next standalone server and official Node runtime
  mkdirSync(join(resources, "runtime"), { recursive: true });

  const standaloneSrc = join(root, "apps/web/.next/standalone");
  const serverDest = join(resources, "server");

  if (platform === "win32") {
    // Windows portable copy: avoids EPERM from cpSync({ dereference: true }) on Next directory junctions
    copyStandaloneForWindows(standaloneSrc, serverDest, root);
    augmentStandaloneDependencies(serverDest);
  } else {
    // macOS and Linux: preserve proven working paths with verbatim symlinks
    cpSync(standaloneSrc, serverDest, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
    });
    if (platform === "linux") {
      augmentStandaloneDependencies(serverDest);
    }
  }

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

  console.log(
    `Downloading and verifying official Node runtime (${process.version}) for ${platform}-${normArch}...`,
  );
  const { archivePath: nodeArchivePath } = await ensureNodeArchive(
    cacheDir,
    process.version,
    normArch,
    platform,
  );

  const nodeTemp = mkdtempSync(join(tmpdir(), "sumi-node-"));
  try {
    if (platform === "win32") {
      execFileSync("unzip", ["-q", nodeArchivePath, "-d", nodeTemp]);
      const runtimeDir = join(nodeTemp, `node-${process.version}-win-${normArch}`);
      cpSync(join(runtimeDir, "node.exe"), join(resources, "runtime/node.exe"));
      const nodeLicense = join(runtimeDir, "LICENSE");
      if (existsSync(nodeLicense)) {
        cpSync(nodeLicense, join(resources, "licenses/Node-LICENSE.txt"));
      }
    } else {
      run("tar", ["-xzf", nodeArchivePath, "-C", nodeTemp]);
      const runtimeDir = join(nodeTemp, `node-${process.version}-${platform}-${normArch}`);
      const nodeDest = join(resources, "runtime/node");
      cpSync(join(runtimeDir, "bin/node"), nodeDest);
      chmodSync(nodeDest, 0o755);
      const nodeLicense = join(runtimeDir, "LICENSE");
      if (existsSync(nodeLicense)) {
        cpSync(nodeLicense, join(resources, "licenses/Node-LICENSE.txt"));
      }
    }
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
  cleanPrivateFiles(join(resources, "server"));

  // Bundle ONLY the lightweight MIT-licensed Silero VAD asset (1.2 MB)
  const sileroSrc = join(root, "models/silero-vad-v6.2-F32.gguf");
  if (!existsSync(sileroSrc)) {
    throw new Error(`Silero VAD model missing at ${sileroSrc}`);
  }
  const sileroBytes = readFileSync(sileroSrc);
  const sileroHash = createHash("sha256").update(sileroBytes).digest("hex");
  if (sileroHash !== SILERO_EXPECTED_SHA256) {
    throw new Error(
      `Silero VAD checksum mismatch: expected ${SILERO_EXPECTED_SHA256}, got ${sileroHash}`,
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

  // Package transcribe-cpp native binary
  const nativeTuple = getNativeTuple(platform, normArch);
  const libName = getNativeLibName(platform);
  if (nativeTuple) {
    try {
      const packageDir = realpathSync(join(root, "apps/web/node_modules/transcribe-cpp"));
      const pkgJson = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
      const entryRelative = pkgJson.exports?.["."]?.import || "./dist/index.js";
      const entryPath = join(packageDir, entryRelative);
      const { artifactDir } = await import(pathToFileURL(entryPath).href);
      const nativeSrc = artifactDir();
      if (!existsSync(join(nativeSrc, libName))) {
        throw new Error(`transcribe-cpp native library missing: ${join(nativeSrc, libName)}`);
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

    // Package Koffi native module from actual installed metadata
    const koffiPkgDir = resolveKoffiPackageDir(root, platform, normArch);
    if (koffiPkgDir && existsSync(koffiPkgDir)) {
      const pkgSubpath = `@koromix/koffi-${platform}-${normArch}`;
      const koffiTargets = [
        join(resources, "server/node_modules", pkgSubpath),
        join(resources, "server/apps/web/node_modules", pkgSubpath),
      ];

      // Also ensure all matching package paths in .pnpm have the full native payload
      const pnpmServer = join(resources, "server/node_modules/.pnpm");
      if (existsSync(pnpmServer)) {
        for (const entry of readdirSync(pnpmServer)) {
          if (entry.includes(`koffi-${platform}-${normArch}`) || entry.startsWith("koffi@")) {
            koffiTargets.push(join(pnpmServer, entry, "node_modules", pkgSubpath));
          }
        }
      }

      for (const targetPkgDir of koffiTargets) {
        mkdirSync(targetPkgDir, { recursive: true });
        cpSync(koffiPkgDir, targetPkgDir, { recursive: true, dereference: true });
      }

      // Assert that the native binary exists in the staged server bundle
      assertKoffiPayload(join(resources, "server"), platform, normArch);
    }
  }

  // Verify self-contained symlinks
  const serverBase = realpathSync(join(resources, "server"));
  assertSelfContained(join(resources, "server"), serverBase);

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
  const pnpmRoot = join(root, "node_modules/.pnpm");
  if (existsSync(pnpmRoot)) {
    for (const entry of readdirSync(pnpmRoot)) {
      collectLicenses(join(pnpmRoot, entry, "node_modules"));
    }
  }

  // 7. Assemble Electron Application Entry in resources/app (unpacked ASAR off)
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

  const appNodeModules = join(appDir, "node_modules");
  mkdirSync(appNodeModules, { recursive: true });

  if (platform === "darwin") {
    // 8a. Sparkle Integration (macOS only)
    const contents = join(stagedApp, "Contents");
    const frameworks = join(contents, "Frameworks");
    const sparklePkgPath = join(root, "node_modules/electron-sparkle");
    if (existsSync(sparklePkgPath)) {
      try {
        console.log(`Materializing and bundling Sparkle updater assets (${normArch})...`);
        const { materializeDarwinDistribution } = await import(
          pathToFileURL(join(sparklePkgPath, "dist/artifacts-C_Z5iSIA.cjs")).href
        );
        const sparkleDist = await materializeDarwinDistribution({
          architecture: normArch,
        });

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

        assertFrameworkSymlinksConfined(frameworkDest);

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

        const sparkleReal = realpathSync(sparklePkgPath);
        cpSync(sparkleReal, join(appNodeModules, "electron-sparkle"), {
          recursive: true,
          dereference: true,
        });

        if (existsSync(pnpmRoot)) {
          for (const entry of readdirSync(pnpmRoot)) {
            if (entry.startsWith("plist@")) {
              const plistModules = join(pnpmRoot, entry, "node_modules");
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

    // Stage update-config.json in resources/app with architecture-split feedUrl
    const stagedUpdateConfig = {
      ...rawUpdateConfig,
      feedUrl: suFeedUrl,
    };
    writeFileSync(
      join(appDir, "update-config.json"),
      JSON.stringify(stagedUpdateConfig, null, 2) + "\n",
      "utf8",
    );

    // Write Info.plist files
    writeFileSync(
      join(contents, "Info.plist"),
      buildInfoPlist(appVersion, {
        suFeedUrl,
        suPublicEDKey,
        minSystemVersion: LS_MINIMUM_SYSTEM_VERSION,
      }),
    );

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
      writeFileSync(frameworkPlist, buildFrameworkInfoPlist(ELECTRON_VERSION));
    }

    // Hardened Runtime Ad-Hoc Code Signing (macOS only)
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

    const efVersionsA = join(frameworks, "Electron Framework.framework/Versions/A");
    signItem(join(efVersionsA, "Libraries/libffmpeg.dylib"));
    signItem(join(efVersionsA, "Libraries/libvk_swiftshader.dylib"));
    signItem(join(efVersionsA, "Helpers/app_shim_loader"));
    signItem(join(efVersionsA, "Helpers/chrome_crashpad_handler"));
    signItem(join(frameworks, "Electron Framework.framework"));
    signItem(join(frameworks, "Mantle.framework"));
    signItem(join(frameworks, "ReactiveObjC.framework"));
    signItem(join(frameworks, "Squirrel.framework"));

    const sparkleFramework = join(frameworks, "Sparkle.framework");
    if (existsSync(sparkleFramework)) {
      signItem(join(frameworks, "electron_sparkle.node"));
      signItem(join(sparkleFramework, "Versions/B/Autoupdate"));
      signItem(join(sparkleFramework, "Versions/B/Updater.app"));
      signItem(sparkleFramework);
    }

    for (const h of helpers) {
      signItem(join(frameworks, h.dir), entitlementsPath);
    }

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
  } else {
    // 8b. Windows / Linux: bundle electron-updater runtime dependency closure
    console.log("Bundling electron-updater runtime dependencies...");
    bundlePackageWithRuntimeDeps("electron-updater", root, appNodeModules);

    if (existsSync(updateConfigPath)) {
      cpSync(updateConfigPath, join(appDir, "update-config.json"));
    }

    // Stage canonical resources/app-update.yml required by electron-updater
    // (when electron-builder runs in prepackaged mode, doPack returns early and skips afterPack,
    // so resources/app-update.yml must be explicitly staged with canonical fork coordinates)
    console.log("Staging canonical resources/app-update.yml...");
    writeFileSync(join(resources, "app-update.yml"), generateAppUpdateYaml(), "utf8");

    // On Windows: bundle licensed app-local Visual C++ 14.x x64 CRT DLLs
    // (MSVCP140.dll, VCRUNTIME140.dll, VCRUNTIME140_1.dll) into runtime and transcribe artifact dirs
    if (platform === "win32") {
      console.log("Locating and bundling Microsoft Visual C++ x64 CRT runtime DLLs...");
      const crtDlls = resolveWindowsCrtDlls();
      const missingDlls = REQUIRED_WIN32_CRT_DLLS.filter((dll) => !crtDlls[dll]);
      if (missingDlls.length > 0) {
        console.warn(
          `Notice: Could not locate app-local VC++ CRT DLLs: ${missingDlls.join(", ")}. User systems without VC++ Redistributable may require them for offline dictation.`,
        );
      }

      const crtTargets = [join(resources, "runtime")];
      if (nativeTuple) {
        crtTargets.push(
          join(resources, "server/node_modules", `@transcribe-cpp/${nativeTuple}`),
          join(resources, "server/apps/web/node_modules", `@transcribe-cpp/${nativeTuple}`),
        );
      }

      for (const targetDir of crtTargets) {
        mkdirSync(targetDir, { recursive: true });
        for (const [dllName, dllPath] of Object.entries(crtDlls)) {
          cpSync(dllPath, join(targetDir, dllName));
        }
      }

      writeFileSync(
        join(resources, "licenses", "Microsoft-Visual-CPP-Redist-Notice.txt"),
        "Microsoft Visual C++ Runtime (MSVCP140.dll, VCRUNTIME140.dll, VCRUNTIME140_1.dll)\n" +
          "Redistributed under Visual Studio 2015-2022 Redistributable License Terms for local application runtime.\n",
        "utf8",
      );
    }
  }

  // 9. Atomic swap: replace output only after complete staging success
  rmSync(output, { recursive: true, force: true });
  renameSync(stagedApp, output);
  rmSync(staging, { recursive: true, force: true });

  console.log(
    `\nBuilt ${output} (v${appVersion}, Electron v${ELECTRON_VERSION}, ${platform}-${normArch})\n`,
  );
  return { output, version: appVersion, platform, arch: normArch };
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirectRun) {
  await build();
}
