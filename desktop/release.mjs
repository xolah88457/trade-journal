import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packageApp, resolveArtifactNames } from "./package.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function getReleaseMetadata(
  projectRoot = root,
  platform = process.platform,
  arch = process.arch,
) {
  const rootPkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
  const version = rootPkg.version || "0.3.0";
  const normArch = arch === "arm64" ? "arm64" : "x64";
  const artifactNames = resolveArtifactNames(version, normArch, platform);
  const distDir = join(projectRoot, "dist");
  const sumsPath = join(distDir, "SHA256SUMS.txt");

  let isBuilt = false;
  let artifactPaths = {};
  let isPackaged = false;

  if (platform === "darwin") {
    isBuilt = existsSync(join(distDir, "Sumi.app"));
    const zipPath = join(distDir, artifactNames.zipName);
    const dmgPath = join(distDir, artifactNames.dmgName);
    artifactPaths = { zipPath, dmgPath };
    isPackaged = existsSync(zipPath) && existsSync(dmgPath) && existsSync(sumsPath);
  } else if (platform === "win32") {
    isBuilt = existsSync(join(distDir, `sumi-win32-${normArch}`, "Sumi.exe"));
    const nsisPath = join(distDir, artifactNames.nsisName);
    const zipPath = join(distDir, artifactNames.zipName);
    artifactPaths = { nsisPath, zipPath };
    isPackaged = existsSync(nsisPath) && existsSync(zipPath) && existsSync(sumsPath);
  } else if (platform === "linux") {
    isBuilt = existsSync(join(distDir, `sumi-linux-${normArch}`, "sumi"));
    const appImagePath = join(distDir, artifactNames.appImageName);
    const debPath = join(distDir, artifactNames.debName);
    artifactPaths = { appImagePath, debPath };
    isPackaged = existsSync(appImagePath) && existsSync(debPath) && existsSync(sumsPath);
  }

  return {
    version,
    platform,
    arch: normArch,
    ...artifactNames,
    ...artifactPaths,
    sumsPath,
    isBuilt,
    isPackaged,
  };
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirectRun) {
  const args = process.argv.slice(2);
  const meta = getReleaseMetadata();
  if (args.includes("--pack")) {
    await packageApp();
  } else {
    console.log(`Sumi Release Status (v${meta.version}, ${meta.platform}-${meta.arch}):`);
    console.log(`  Built desktop app: ${meta.isBuilt ? "FOUND" : "NOT FOUND"}`);
    if (meta.platform === "darwin") {
      console.log(
        `  ZIP artifact (${meta.zipName}): ${existsSync(meta.zipPath) ? "FOUND" : "NOT FOUND"}`,
      );
      console.log(
        `  DMG artifact (${meta.dmgName}): ${existsSync(meta.dmgPath) ? "FOUND" : "NOT FOUND"}`,
      );
    } else if (meta.platform === "win32") {
      console.log(
        `  NSIS installer (${meta.nsisName}): ${existsSync(meta.nsisPath) ? "FOUND" : "NOT FOUND"}`,
      );
      console.log(
        `  Portable ZIP (${meta.zipName}): ${existsSync(meta.zipPath) ? "FOUND" : "NOT FOUND"}`,
      );
    } else if (meta.platform === "linux") {
      console.log(
        `  AppImage (${meta.appImageName}): ${existsSync(meta.appImagePath) ? "FOUND" : "NOT FOUND"}`,
      );
      console.log(
        `  Deb package (${meta.debName}): ${existsSync(meta.debPath) ? "FOUND" : "NOT FOUND"}`,
      );
    }
    console.log(
      `  Checksums (SHA256SUMS.txt): ${existsSync(meta.sumsPath) ? "FOUND" : "NOT FOUND"}`,
    );
    if (meta.isPackaged) {
      console.log(`\nChecksums:\n${readFileSync(meta.sumsPath, "utf8").trim()}`);
    } else {
      console.log(`\nTo build and package, run:\n  pnpm desktop:build\n  pnpm desktop:package`);
    }
  }
}
