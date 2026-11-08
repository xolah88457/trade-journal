import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ELECTRON_VERSION, REQUIRED_DESKTOP_SCRIPTS, REQUIRED_WIN32_CRT_DLLS } from "./build.mjs";
import {
  checkNoPrivateFiles,
  checkSelfContainedSymlinks,
  normalizeArch,
  readRootVersion,
  sha256File,
} from "./lib/common.mjs";

export { checkNoPrivateFiles, checkSelfContainedSymlinks };

export const GITHUB_PUBLISH_CONFIG = Object.freeze([
  {
    provider: "github",
    owner: "xolah88457",
    repo: "trade-journal",
  },
]);

export const DEBIAN_MAINTAINER = "Sumi contributors <noreply@github.com>";

export function resolveArtifactNames(version, arch = process.arch, platform = process.platform) {
  const normArch = normalizeArch(arch);
  if (platform === "darwin") {
    return {
      zipName: `Sumi-${version}-macos-${normArch}.zip`,
      dmgName: `Sumi-${version}-macos-${normArch}.dmg`,
    };
  }
  if (platform === "win32") {
    return {
      nsisName: `Sumi-${version}-win32-${normArch}-setup.exe`,
      zipName: `Sumi-${version}-win32-${normArch}.zip`,
    };
  }
  if (platform === "linux") {
    return {
      appImageName: `Sumi-${version}-linux-${normArch}.AppImage`,
      debName: `Sumi-${version}-linux-${normArch}.deb`,
    };
  }
  return {
    zipName: `Sumi-${version}-${platform}-${normArch}.zip`,
  };
}

/**
 * Invokes hdiutil create with bounded retry for transient "Resource busy" errors.
 * Spotlight or background system daemons on macOS CI runners can briefly lock files
 * in staging, throwing "hdiutil: create failed - Resource busy". Retries up to 3 times
 * with a 2-second delay only on resource busy.
 */
export function createDmgWithRetry(
  dmgStaging,
  dmgPath,
  maxRetries = 3,
  delayMs = 2000,
  execFn = execFileSync,
) {
  const args = [
    "create",
    "-volname",
    "Sumi",
    "-srcfolder",
    dmgStaging,
    "-ov",
    "-format",
    "UDZO",
    dmgPath,
  ];

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      rmSync(dmgPath, { force: true });
      execFn("hdiutil", args, { stdio: "pipe" });
      return;
    } catch (err) {
      const stderr = err.stderr ? err.stderr.toString("utf8") : err.message || "";
      const isBusy = /resource busy/i.test(stderr);
      if (isBusy && attempt < maxRetries) {
        console.warn(
          `[DMG] hdiutil reported resource busy (attempt ${attempt}/${maxRetries}), retrying in ${delayMs / 1000}s...`,
        );
        const buffer = new Int32Array(new SharedArrayBuffer(4));
        Atomics.wait(buffer, 0, 0, delayMs);
        continue;
      }
      const sanitized = stderr.replace(
        /([A-Za-z]:\\[^\s:"'<>)]*)|(\/(?:Users|home|private|tmp|var)[^\s:"'<>)]*)/gi,
        "[path]",
      );
      throw new Error(`hdiutil DMG creation failed: ${sanitized.trim()}`);
    }
  }
}

export function extractPlistValue(plistContent, key) {
  if (typeof plistContent !== "string") return null;
  const regex = new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`);
  const match = plistContent.match(regex);
  return match ? match[1] : null;
}

export function getYamlLib() {
  try {
    const req = createRequire(import.meta.url);
    const updaterEntry = req.resolve("electron-updater");
    const updaterReq = createRequire(updaterEntry);
    return updaterReq("js-yaml");
  } catch {
    return null;
  }
}

/**
 * Merges two Linux update YAML files (AppImage and deb) into a unified latest-linux.yml
 * so that both AppImageUpdater and DebUpdater locate their respective binaries.
 */
export function mergeLinuxYml(meta1, meta2) {
  const yaml = getYamlLib();
  if (!yaml) return meta2 || meta1;
  const doc1 = yaml.load(meta1) || {};
  const doc2 = yaml.load(meta2) || {};

  const files1 = Array.isArray(doc1.files) ? doc1.files : [];
  const files2 = Array.isArray(doc2.files) ? doc2.files : [];
  const mergedFiles = [...files1];

  for (const f2 of files2) {
    if (!mergedFiles.some((f1) => f1.url === f2.url)) {
      mergedFiles.push(f2);
    }
  }

  // Preserve AppImage as top-level path/sha512 when available
  const appImageFile = mergedFiles.find((f) => f.url && f.url.endsWith(".AppImage"));
  const primary = appImageFile ? doc1 : doc2;

  const merged = {
    ...doc2,
    ...primary,
    files: mergedFiles,
  };
  return yaml.dump(merged, { lineWidth: -1 });
}

/** Windows/Linux: the staged resources/package.json (if any) must carry the expected version. */
function assertResourcesVersion(appPath, expectedVersion) {
  const pkgPath = join(appPath, "resources", "package.json");
  if (!existsSync(pkgPath)) return;
  const meta = JSON.parse(readFileSync(pkgPath, "utf8"));
  if (meta.version && meta.version !== expectedVersion) {
    throw new Error(
      `Version mismatch: package.json specifies ${expectedVersion} but app resources contains ${meta.version}.`,
    );
  }
}

/** No private files anywhere in resources, and the staged server tree stays self-contained. */
function assertResourcesClean(resourcesPath) {
  checkNoPrivateFiles(resourcesPath);
  const serverPath = join(resourcesPath, "server");
  if (existsSync(serverPath)) {
    checkSelfContainedSymlinks(serverPath, realpathSync(serverPath) + "/");
  }
}

/**
 * Windows/Linux: resources/app-update.yml must exist with the canonical fork coordinates.
 * electron-builder's prepackaged mode skips afterPack, so build.mjs stages this file itself.
 */
function assertAppUpdateYml(resourcesPath) {
  const appUpdatePath = join(resourcesPath, "app-update.yml");
  if (!existsSync(appUpdatePath)) {
    throw new Error(`Required updater configuration missing: ${appUpdatePath}`);
  }
  const rawYml = readFileSync(appUpdatePath, "utf8");
  if (
    !rawYml.includes("owner: xolah88457") ||
    !rawYml.includes("repo: trade-journal") ||
    !rawYml.includes("updaterCacheDirName: sumi-updater")
  ) {
    throw new Error(`Invalid app-update.yml configuration in ${appUpdatePath}`);
  }
}

/**
 * Lightweight pre-packaging sanity check of a staged app. The exhaustive structural check
 * (licenses, Silero model, runtime binaries, native libraries) is check-support.mjs
 * verifyPackageForPlatform, run by `pnpm desktop:check` before packaging; this adds the
 * checks only packaging needs (version, updater configuration, artifact preconditions).
 */
export function verifyBuiltApp(appPath, expectedVersion, platform = process.platform) {
  if (!existsSync(appPath)) {
    throw new Error(`Built application missing at ${appPath}. Run 'pnpm desktop:build' first.`);
  }

  if (platform === "darwin") {
    const plistPath = join(appPath, "Contents", "Info.plist");
    if (!existsSync(plistPath)) {
      throw new Error(`Contents/Info.plist missing at ${plistPath}`);
    }

    const plistContent = readFileSync(plistPath, "utf8");
    const plistVersion =
      extractPlistValue(plistContent, "CFBundleShortVersionString") ||
      extractPlistValue(plistContent, "CFBundleVersion");
    if (plistVersion !== expectedVersion) {
      throw new Error(
        `Version mismatch: package.json specifies ${expectedVersion} but Sumi.app Info.plist contains ${plistVersion}.`,
      );
    }

    const executable = extractPlistValue(plistContent, "CFBundleExecutable");
    if (executable !== "Sumi") {
      throw new Error(
        `Executable mismatch: expected 'Sumi' but Info.plist specifies '${executable}'.`,
      );
    }

    const macosBinary = join(appPath, "Contents", "MacOS", "Sumi");
    if (!existsSync(macosBinary)) {
      throw new Error(`Application executable missing at ${macosBinary}`);
    }

    execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "pipe" });

    const resourcesPath = join(appPath, "Contents", "Resources");
    if (existsSync(resourcesPath)) assertResourcesClean(resourcesPath);

    return { plistVersion, executable };
  }

  // Verify desktop scripts presence across all other platforms
  const appDir = join(appPath, "resources", "app");
  if (existsSync(appDir)) {
    for (const script of REQUIRED_DESKTOP_SCRIPTS) {
      if (!existsSync(join(appDir, script))) {
        throw new Error(`Required desktop script missing from application bundle: ${script}`);
      }
    }
  }

  const resourcesPath = join(appPath, "resources");

  if (platform === "win32") {
    const exePath = join(appPath, "Sumi.exe");
    if (!existsSync(exePath)) {
      throw new Error(`Application executable missing at ${exePath}`);
    }
    assertResourcesVersion(appPath, expectedVersion);

    if (existsSync(resourcesPath)) {
      assertResourcesClean(resourcesPath);

      // Assert shipped required VC++ CRT DLLs exist in runtime directory if present
      const runtimeDir = join(resourcesPath, "runtime");
      if (existsSync(runtimeDir)) {
        for (const dll of REQUIRED_WIN32_CRT_DLLS) {
          if (!existsSync(join(runtimeDir, dll))) {
            throw new Error(
              `Required Windows VC++ CRT runtime DLL missing from distribution: ${dll}`,
            );
          }
        }
      }

      assertAppUpdateYml(resourcesPath);
    }

    return { executable: "Sumi.exe", version: expectedVersion };
  }

  if (platform === "linux") {
    const binPath = join(appPath, "sumi");
    if (!existsSync(binPath)) {
      throw new Error(`Application executable missing at ${binPath}`);
    }
    assertResourcesVersion(appPath, expectedVersion);

    const sandboxPath = join(appPath, "chrome-sandbox");
    if (!existsSync(sandboxPath)) {
      console.warn(`Notice: chrome-sandbox not found at ${sandboxPath}`);
    }

    if (existsSync(resourcesPath)) {
      assertResourcesClean(resourcesPath);
      assertAppUpdateYml(resourcesPath);
    }

    return { executable: "sumi", version: expectedVersion };
  }

  return { executable: "Sumi", version: expectedVersion };
}

/**
 * Packages the staged desktop application into production distribution formats.
 * - macOS: native ZIP (ditto) and DMG (hdiutil)
 * - Windows: NSIS installer and portable ZIP via electron-builder (prepackaged, npmRebuild: false, publish: "never")
 * - Linux: AppImage and deb via electron-builder (prepackaged, npmRebuild: false, publish: "never", merged latest-linux.yml)
 */
export async function packageApp(options = {}) {
  const root = options.root || resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const normArch = normalizeArch(arch);

  const version = options.version || readRootVersion(root);

  const distDir = options.distDir || join(root, "dist");
  const defaultAppPath =
    platform === "darwin"
      ? join(distDir, "Sumi.app")
      : platform === "win32"
        ? join(distDir, `sumi-win32-${normArch}`)
        : join(distDir, `sumi-linux-${normArch}`);

  const appPath = options.appPath || defaultAppPath;

  // 1. Verify staged application before packaging
  verifyBuiltApp(appPath, version, platform);

  const sumsPath = join(distDir, "SHA256SUMS.txt");
  const artifacts = [];

  if (platform === "darwin") {
    const { zipName, dmgName } = resolveArtifactNames(version, normArch, "darwin");
    const zipPath = join(distDir, zipName);
    const dmgPath = join(distDir, dmgName);

    console.log(`Creating ZIP archive: ${zipName}...`);
    rmSync(zipPath, { force: true });
    execFileSync("ditto", ["-c", "-k", "--keepParent", appPath, zipPath], { stdio: "inherit" });

    console.log(`Creating DMG image: ${dmgName}...`);
    rmSync(dmgPath, { force: true });
    const dmgStaging = mkdtempSync(join(tmpdir(), "sumi-dmg-staging-"));
    try {
      cpSync(appPath, join(dmgStaging, "Sumi.app"), {
        recursive: true,
        dereference: false,
        verbatimSymlinks: true,
      });
      symlinkSync("/Applications", join(dmgStaging, "Applications"));
      createDmgWithRetry(dmgStaging, dmgPath, 3, 2000, options.customHdiutil || execFileSync);
    } finally {
      rmSync(dmgStaging, { recursive: true, force: true });
    }

    const zipSha = sha256File(zipPath);
    const dmgSha = sha256File(dmgPath);
    artifacts.push({ name: zipName, path: zipPath, sha: zipSha });
    artifacts.push({ name: dmgName, path: dmgPath, sha: dmgSha });
  } else if (platform === "win32") {
    // Windows packaging via electron-builder PREPACKAGED mode
    const builder = options.customBuilder || (await import("electron-builder")).build;
    const { Platform, Arch } = await import("electron-builder");
    const { nsisName, zipName } = resolveArtifactNames(version, normArch, "win32");
    const targetArch = normArch === "arm64" ? Arch.arm64 : Arch.x64;

    console.log(`Packaging Windows distribution (NSIS + Portable ZIP)...`);
    await builder({
      targets: Platform.WINDOWS.createTarget(["nsis", "zip"], targetArch),
      prepackaged: appPath,
      publish: "never",
      config: {
        appId: "local.sumi.journal",
        productName: "Sumi",
        directories: {
          output: distDir,
        },
        publish: GITHUB_PUBLISH_CONFIG,
        npmRebuild: false,
        electronVersion: ELECTRON_VERSION,
        win: {
          executableName: "Sumi",
          artifactName: zipName,
        },
        nsis: {
          oneClick: false,
          allowToChangeInstallationDirectory: true,
          artifactName: nsisName,
        },
      },
    });

    const nsisPath = join(distDir, nsisName);
    if (!existsSync(nsisPath)) {
      throw new Error(`Expected Windows NSIS installer missing after build: ${nsisPath}`);
    }
    const zipPath = join(distDir, zipName);
    if (!existsSync(zipPath)) {
      throw new Error(`Expected Windows ZIP package missing after build: ${zipPath}`);
    }
    artifacts.push({ name: nsisName, path: nsisPath, sha: sha256File(nsisPath) });
    artifacts.push({ name: zipName, path: zipPath, sha: sha256File(zipPath) });
  } else if (platform === "linux") {
    // Linux packaging via electron-builder PREPACKAGED mode
    const builder = options.customBuilder || (await import("electron-builder")).build;
    const { Platform, Arch } = await import("electron-builder");
    const { appImageName, debName } = resolveArtifactNames(version, normArch, "linux");
    const targetArch = normArch === "arm64" ? Arch.arm64 : Arch.x64;

    const resourcesDir = join(appPath, "resources");
    const packageTypeFile = join(resourcesDir, "package-type");

    // 1. AppImage build: ensure package-type file is absent so electron-updater defaults to AppImage
    console.log(`Packaging Linux AppImage (${appImageName})...`);
    rmSync(packageTypeFile, { force: true });
    await builder({
      targets: Platform.LINUX.createTarget(["appimage"], targetArch),
      prepackaged: appPath,
      publish: "never",
      config: {
        appId: "local.sumi.journal",
        productName: "Sumi",
        directories: {
          output: distDir,
        },
        publish: GITHUB_PUBLISH_CONFIG,
        npmRebuild: false,
        electronVersion: ELECTRON_VERSION,
        linux: {
          executableName: "sumi",
          category: "Finance",
          maintainer: DEBIAN_MAINTAINER,
        },
        appImage: {
          artifactName: appImageName,
        },
      },
    });

    const latestLinuxPath = join(distDir, "latest-linux.yml");
    let appImageLatestYml = null;
    if (existsSync(latestLinuxPath)) {
      appImageLatestYml = readFileSync(latestLinuxPath, "utf8");
    }

    // 2. deb build: stage package-type with "deb\n" so electron-updater's auto-detect uses DebUpdater
    console.log(`Packaging Linux deb package (${debName})...`);
    writeFileSync(packageTypeFile, "deb\n", "utf8");
    try {
      await builder({
        targets: Platform.LINUX.createTarget(["deb"], targetArch),
        prepackaged: appPath,
        publish: "never",
        config: {
          appId: "local.sumi.journal",
          productName: "Sumi",
          directories: {
            output: distDir,
          },
          publish: GITHUB_PUBLISH_CONFIG,
          npmRebuild: false,
          electronVersion: ELECTRON_VERSION,
          linux: {
            executableName: "sumi",
            category: "Finance",
            maintainer: DEBIAN_MAINTAINER,
          },
          deb: {
            artifactName: debName,
            packageCategory: "utils",
            // Uses electron-builder standard default deb dependencies for GTK/audio/X11
          },
        },
      });
    } finally {
      // Clean up package-type file from staged app
      rmSync(packageTypeFile, { force: true });
    }

    // Merge AppImage and Deb metadata entries into latest-linux.yml
    if (appImageLatestYml && existsSync(latestLinuxPath)) {
      const debLatestYml = readFileSync(latestLinuxPath, "utf8");
      const mergedYaml = mergeLinuxYml(appImageLatestYml, debLatestYml);
      writeFileSync(latestLinuxPath, mergedYaml, "utf8");
    }

    const appImagePath = join(distDir, appImageName);
    if (!existsSync(appImagePath)) {
      throw new Error(`Expected Linux AppImage missing after build: ${appImagePath}`);
    }
    const debPath = join(distDir, debName);
    if (!existsSync(debPath)) {
      throw new Error(`Expected Linux deb package missing after build: ${debPath}`);
    }
    artifacts.push({ name: appImageName, path: appImagePath, sha: sha256File(appImagePath) });
    artifacts.push({ name: debName, path: debPath, sha: sha256File(debPath) });
  }

  // 4. Generate SHA256SUMS.txt
  let sumsContent = "";
  for (const art of artifacts) {
    sumsContent += `${art.sha}  ${art.name}\n`;
  }
  writeFileSync(sumsPath, sumsContent, "utf8");

  console.log(`\nPackaged distribution artifacts (v${version}, ${platform}-${normArch}):`);
  for (const art of artifacts) {
    const sizeMb = (statSync(art.path).size / (1024 * 1024)).toFixed(1);
    console.log(`  ${art.name} (${sizeMb} MB)`);
    console.log(`    SHA-256: ${art.sha}`);
  }
  console.log(`  SUMS: ${sumsPath}`);

  return {
    version,
    platform,
    arch: normArch,
    artifacts,
    sumsPath,
    ...(platform === "darwin"
      ? {
          zipPath: artifacts.find((a) => a.name.endsWith(".zip"))?.path,
          zipSha: artifacts.find((a) => a.name.endsWith(".zip"))?.sha,
          dmgPath: artifacts.find((a) => a.name.endsWith(".dmg"))?.path,
          dmgSha: artifacts.find((a) => a.name.endsWith(".dmg"))?.sha,
        }
      : {}),
  };
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirectRun) {
  await packageApp();
}
