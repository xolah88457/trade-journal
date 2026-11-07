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

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "darwin") throw new Error("Sumi's native desktop build requires macOS.");
const output = join(root, "dist", "Sumi.app");
const staging = join(root, "dist/.Sumi-build");
const stagedApp = join(staging, "Sumi.app");
const contents = join(stagedApp, "Contents");
const resources = join(contents, "Resources");
const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: "inherit" });

// Fail before replacing an existing app if the production build is broken.
run("pnpm", ["build"]);
rmSync(staging, { recursive: true, force: true });
mkdirSync(join(contents, "MacOS"), { recursive: true });
mkdirSync(join(resources, "runtime"), { recursive: true });
mkdirSync(join(resources, "licenses"), { recursive: true });
cpSync(join(root, "apps/web/.next/standalone"), join(resources, "server"), {
  recursive: true,
  dereference: false,
  verbatimSymlinks: true,
});
const web = join(resources, "server/apps/web");
// Next's generated fallback treats PORT=0 as 3000; preserve true OS-assigned ports.
const entrypoint = join(web, "server.js");
const generated = readFileSync(entrypoint, "utf8");
const portFallback = "parseInt(process.env.PORT, 10) || 3000";
if (!generated.includes(portFallback))
  throw new Error("Next's standalone entrypoint changed; review ephemeral port handling.");
writeFileSync(
  entrypoint,
  generated.replace(portFallback, `(process.env.PORT === "0" ? 0 : (${portFallback}))`),
);
cpSync(join(root, "apps/web/.next/static"), join(web, ".next/static"), { recursive: true });
cpSync(join(root, "apps/web/public"), join(web, "public"), { recursive: true });
// Official Node is self-contained; a Homebrew binary depends on /opt/homebrew dylibs.
const runtimeVersion = process.version;
const archive = `node-${runtimeVersion}-darwin-${process.arch}.tar.gz`;
const base = `https://nodejs.org/dist/${runtimeVersion}`;
const temporary = mkdtempSync(join(tmpdir(), "sumi-node-"));
try {
  const [archiveResponse, sumsResponse] = await Promise.all([
    fetch(`${base}/${archive}`, { signal: AbortSignal.timeout(120_000) }),
    fetch(`${base}/SHASUMS256.txt`, { signal: AbortSignal.timeout(30_000) }),
  ]);
  if (!archiveResponse.ok || !sumsResponse.ok)
    throw new Error(`Could not download official Node ${runtimeVersion}.`);
  const bytes = Buffer.from(await archiveResponse.arrayBuffer());
  const checksum = (await sumsResponse.text())
    .split("\n")
    .find((line) => line.endsWith(`  ${archive}`))
    ?.split(/\s+/)[0];
  if (!checksum || createHash("sha256").update(bytes).digest("hex") !== checksum)
    throw new Error("Node archive checksum mismatch.");
  writeFileSync(join(temporary, archive), bytes);
  run("tar", ["-xzf", join(temporary, archive), "-C", temporary]);
  const runtime = join(temporary, `node-${runtimeVersion}-darwin-${process.arch}`);
  cpSync(join(runtime, "bin/node"), join(resources, "runtime/node"));
  cpSync(join(runtime, "LICENSE"), join(resources, "licenses/Node-LICENSE.txt"));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
cpSync(join(root, "desktop/launch.cjs"), join(resources, "launch.cjs"));
writeFileSync(
  join(resources, "package.json"),
  JSON.stringify(
    { name: "sumi-desktop", version: "0.1.0", type: "commonjs", private: true },
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

// Next can trace environment files; never ship credentials or a development journal.
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
    } else if (entry.isDirectory()) clean(path);
  }
}
clean(join(resources, "server"));

// Bundle ONLY the lightweight MIT-licensed Silero VAD asset (1.2 MB) into the web app server.
// Heavy ASR weights (Parakeet ~731 MB) are strictly forbidden in .app and reside in user data outside the bundle.
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

// Package transcribe-cpp and koffi native runtime dependencies if dynamic artifacts are not traced
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

  // Ensure koffi darwin-arm64 binary package is dereferenced inside server bundle
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

// Verify all symlinks in the bundled server stay strictly within the server bundle.
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

// Generate native application icon from Icon.swift using sips and iconutil.
const iconCache = join(root, ".desktop-cache");
mkdirSync(iconCache, { recursive: true });
const iconTemp = mkdtempSync(join(tmpdir(), "sumi-icon-"));
try {
  const masterPng = join(iconTemp, "icon_1024x1024.png");
  run("xcrun", [
    "swift",
    "-module-cache-path",
    iconCache,
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

run("xcrun", [
  "swiftc",
  "-O",
  "-module-cache-path",
  join(root, ".desktop-cache"),
  "-target",
  `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx13.0`,
  "-framework",
  "Cocoa",
  "-framework",
  "WebKit",
  join(root, "desktop/Sumi.swift"),
  "-o",
  join(contents, "MacOS/Sumi"),
]);
writeFileSync(
  join(contents, "Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Sumi</string>
<key>CFBundleDisplayName</key><string>Sumi</string>
<key>CFBundleIdentifier</key><string>local.sumi.journal</string>
<key>CFBundleExecutable</key><string>Sumi</string>
<key>CFBundleIconFile</key><string>Sumi</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSSupportsAutomaticTermination</key><false/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
<key>NSMicrophoneUsageDescription</key><string>Sumi uses the microphone for local voice dictation in journal notes. Audio is processed on-device and never sent to external servers.</string>
<key>NSHumanReadableCopyright</key><string>Based on MIT-licensed work by LuxAlgo Global, LLC and Tw93. Independent fork.</string>
</dict></plist>\n`,
);
// Ad-hoc signing supports local use; public distribution needs your own Developer ID.
run("codesign", ["--force", "--deep", "--sign", "-", stagedApp]);
rmSync(output, { recursive: true, force: true });
renameSync(stagedApp, output);
rmSync(staging, { recursive: true, force: true });
console.log(`\nBuilt ${output}\nOpen it in Finder, or run: open "${output}"`);
