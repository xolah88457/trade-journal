import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeArch } from "./lib/common.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Returns the predictable platform-specific executable/application bundle path.
 */
export function getExecutablePath(
  platform = process.platform,
  arch = process.arch,
  baseDir = join(root, "dist"),
) {
  const normArch = normalizeArch(arch);
  if (platform === "darwin") {
    return join(baseDir, "Sumi.app");
  }
  if (platform === "win32") {
    return join(baseDir, `sumi-win32-${normArch}`, "Sumi.exe");
  }
  if (platform === "linux") {
    return join(baseDir, `sumi-linux-${normArch}`, "sumi");
  }
  throw new Error(`Unsupported platform: ${platform}`);
}

/**
 * Launches the built application on macOS, Windows, or Linux.
 */
export function openApp(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const baseDir = options.distDir || join(root, "dist");
  const execPath = options.execPath || getExecutablePath(platform, arch, baseDir);

  if (!existsSync(execPath)) {
    const message = `No desktop build found at ${execPath}. Run 'pnpm desktop:build' first.`;
    if (options.throwOnMissing) {
      throw new Error(message);
    }
    console.error(message);
    process.exit(1);
  }

  console.log(`Opening Sumi (${platform}-${arch}): ${execPath}`);
  if (platform === "darwin") {
    execFileSync("open", [execPath], { stdio: "inherit" });
  } else if (platform === "win32" || platform === "linux") {
    const child = spawn(execPath, [], { detached: true, stdio: "ignore" });
    child.unref();
  }
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirectRun) {
  openApp();
}
