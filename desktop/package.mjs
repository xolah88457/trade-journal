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
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function resolveArtifactNames(version, arch = process.arch) {
  const normArch = arch === "arm64" ? "arm64" : "x64";
  return {
    zipName: `Sumi-${version}-macos-${normArch}.zip`,
    dmgName: `Sumi-${version}-macos-${normArch}.dmg`,
  };
}

export function extractPlistValue(plistContent, key) {
  if (typeof plistContent !== "string") return null;
  const regex = new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`);
  const match = plistContent.match(regex);
  return match ? match[1] : null;
}

export function checkNoPrivateFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".env")) {
      throw new Error(`Environment file bundled in distribution: ${entry.name}`);
    }
    if (/\.(db|sqlite)(-shm|-wal|-journal)?$/.test(entry.name)) {
      throw new Error(`Database bundled in distribution: ${entry.name}`);
    }
    if (entry.name.endsWith(".gguf") && entry.name !== "silero-vad-v6.2-F32.gguf") {
      throw new Error(`Forbidden model weights bundled in distribution: ${entry.name}`);
    }
    if (entry.name === ".secret") {
      throw new Error(`Secret file bundled in distribution: ${entry.name}`);
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      checkNoPrivateFiles(path);
    }
  }
}

export function checkSelfContainedSymlinks(directory, basePrefix) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const real = realpathSync(path);
      if (!real.startsWith(basePrefix)) {
        throw new Error(`Symlink escapes application bundle: ${path} -> ${real}`);
      }
    } else if (entry.isDirectory()) {
      checkSelfContainedSymlinks(path, basePrefix);
    }
  }
}

export function verifyBuiltApp(appPath, expectedVersion) {
  if (!existsSync(appPath)) {
    throw new Error(`Built application missing at ${appPath}. Run 'pnpm desktop:build' first.`);
  }

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

  // Strict code signature verification of the entire bundle
  execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "pipe" });

  // Disallow private files and escaping symlinks
  const resourcesPath = join(appPath, "Contents", "Resources");
  if (existsSync(resourcesPath)) {
    checkNoPrivateFiles(resourcesPath);
    const serverPath = join(resourcesPath, "server");
    if (existsSync(serverPath)) {
      const serverPrefix = realpathSync(serverPath) + "/";
      checkSelfContainedSymlinks(serverPath, serverPrefix);
    }
  }

  return { plistVersion, executable };
}

export function packageApp(options = {}) {
  const root = options.root || resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const distDir = options.distDir || join(root, "dist");
  const appPath = options.appPath || join(distDir, "Sumi.app");

  const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const version = options.version || rootPkg.version || "0.2.0";
  const arch = options.arch || process.arch;

  // 1. Verify existing built application
  verifyBuiltApp(appPath, version);

  const { zipName, dmgName } = resolveArtifactNames(version, arch);
  const zipPath = join(distDir, zipName);
  const dmgPath = join(distDir, dmgName);
  const sumsPath = join(distDir, "SHA256SUMS.txt");

  // 2. Package ZIP via ditto -c -k --keepParent
  console.log(`Creating ZIP archive: ${zipName}...`);
  rmSync(zipPath, { force: true });
  execFileSync("ditto", ["-c", "-k", "--keepParent", appPath, zipPath], { stdio: "inherit" });

  // 3. Package DMG via hdiutil with /Applications symlink staging
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
    execFileSync(
      "hdiutil",
      ["create", "-volname", "Sumi", "-srcfolder", dmgStaging, "-ov", "-format", "UDZO", dmgPath],
      { stdio: "inherit" },
    );
  } finally {
    rmSync(dmgStaging, { recursive: true, force: true });
  }

  // 4. Generate SHA256 checksums
  const zipBytes = readFileSync(zipPath);
  const dmgBytes = readFileSync(dmgPath);
  const zipSha = createHash("sha256").update(zipBytes).digest("hex");
  const dmgSha = createHash("sha256").update(dmgBytes).digest("hex");

  const sumsContent = `${zipSha}  ${zipName}\n${dmgSha}  ${dmgName}\n`;
  writeFileSync(sumsOutput(distDir), sumsContent, "utf8");

  const zipSizeMb = (statSync(zipPath).size / (1024 * 1024)).toFixed(1);
  const dmgSizeMb = (statSync(dmgPath).size / (1024 * 1024)).toFixed(1);

  console.log(`\nPackaged distribution artifacts (v${version}, ${arch}):`);
  console.log(`  ZIP: ${zipPath} (${zipSizeMb} MB)`);
  console.log(`       SHA-256: ${zipSha}`);
  console.log(`  DMG: ${dmgPath} (${dmgSizeMb} MB)`);
  console.log(`       SHA-256: ${dmgSha}`);
  console.log(`  SUMS: ${sumsPath}`);

  return {
    version,
    arch,
    zipPath,
    zipSha,
    dmgPath,
    dmgSha,
    sumsPath,
  };
}

function sumsOutput(distDir) {
  return join(distDir, "SHA256SUMS.txt");
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirectRun) {
  packageApp();
}
