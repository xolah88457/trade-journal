import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packageApp, resolveArtifactNames } from "./package.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function getReleaseMetadata(projectRoot = root) {
  const rootPkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
  const version = rootPkg.version || "0.2.0";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const { zipName, dmgName } = resolveArtifactNames(version, arch);
  const distDir = join(projectRoot, "dist");
  const zipPath = join(distDir, zipName);
  const dmgPath = join(distDir, dmgName);
  const sumsPath = join(distDir, "SHA256SUMS.txt");

  return {
    version,
    arch,
    zipName,
    dmgName,
    zipPath,
    dmgPath,
    sumsPath,
    isBuilt: existsSync(join(distDir, "Sumi.app")),
    isPackaged: existsSync(zipPath) && existsSync(dmgPath) && existsSync(sumsPath),
  };
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirectRun) {
  const args = process.argv.slice(2);
  const meta = getReleaseMetadata();
  if (args.includes("--pack")) {
    packageApp();
  } else {
    console.log(`Sumi Release Status (v${meta.version}, macos-${meta.arch}):`);
    console.log(`  Built app (dist/Sumi.app): ${meta.isBuilt ? "FOUND" : "NOT FOUND"}`);
    console.log(
      `  ZIP artifact (${meta.zipName}): ${existsSync(meta.zipPath) ? "FOUND" : "NOT FOUND"}`,
    );
    console.log(
      `  DMG artifact (${meta.dmgName}): ${existsSync(meta.dmgPath) ? "FOUND" : "NOT FOUND"}`,
    );
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
