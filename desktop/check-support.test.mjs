import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  EXPECTED_ELECTRON_VERSION,
  SILERO_EXPECTED_SIZE,
  TOOL_OUTPUT_MAX_BUFFER,
  WINDOWS_REQUIRED_CRT_DLLS,
  checkNoPrivateFiles,
  checkSelfContainedSymlinks,
  extractPlistString,
  findLicenseFile,
  isBaseOrChildPath,
  resolvePackageLayout,
  runNativeAsrDoctor,
  validateInfoPlistContent,
  verifyAppPackage,
  verifyElectronFramework,
  verifyLinuxPackage,
  verifyWindowsPackage,
} from "./check-support.mjs";

const realSileroPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../models/silero-vad-v6.2-F32.gguf",
);

function withTempDir(fn) {
  const tempDir = mkdtempSync(join(tmpdir(), "check-support-unit-"));
  try {
    return fn(tempDir);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

const SHELL_FILES_030 = [
  "main.cjs",
  "preload.cjs",
  "preferences.cjs",
  "security.cjs",
  "update-service.cjs",
  "update-service-platform.cjs",
];

test("checkNoPrivateFiles allows only the Silero VAD model and no secret files", () => {
  withTempDir((tempDir) => {
    const cleanDir = join(tempDir, "clean");
    mkdirSync(cleanDir, { recursive: true });
    writeFileSync(join(cleanDir, "silero-vad-v6.2-F32.gguf"), "model");
    writeFileSync(join(cleanDir, "index.js"), "code");
    checkNoPrivateFiles(cleanDir);

    const secretDir = join(tempDir, "secret");
    mkdirSync(join(secretDir, "nested"), { recursive: true });
    writeFileSync(join(secretDir, "nested", ".secret"), "x");
    assert.throws(() => checkNoPrivateFiles(secretDir), /Secret file bundled/);
  });
});

test("checkSelfContainedSymlinks accepts internal links and rejects escapes", () => {
  withTempDir((tempDir) => {
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
  });
});

test("isBaseOrChildPath is a pure cross-platform containment check", () => {
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
});

test("validateInfoPlistContent enforces version, bundle id and minimum system version", () => {
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
  assert.throws(() => validateInfoPlistContent(badIdPlist, "0.2.0"), /CFBundleIdentifier must be/);

  const badSysPlist = validPlist.replace("14.0", "13.0");
  assert.throws(
    () => validateInfoPlistContent(badSysPlist, "0.2.0"),
    /LSMinimumSystemVersion must be >= 14.0/,
  );
});

test("verifyAppPackage requires shell files and a matching version", () => {
  withTempDir((tempDir) => {
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

    // 0.3.0 requires update-service-platform.cjs
    writeFileSync(
      join(mockApp, "package.json"),
      JSON.stringify({ main: "main.cjs", version: "0.3.0" }),
    );
    for (const f of SHELL_FILES_030) writeFileSync(join(mockApp, f), "// shell");
    verifyAppPackage(mockResources, "0.3.0");

    rmSync(join(mockApp, "update-service-platform.cjs"));
    assert.throws(
      () => verifyAppPackage(mockResources, "0.3.0"),
      /Required shell file missing: Resources\/app\/update-service-platform\.cjs/,
    );
  });
});

test("findLicenseFile rejects missing or too-short notices", () => {
  withTempDir((tempDir) => {
    const shortLic = join(tempDir, "short.txt");
    writeFileSync(shortLic, "short");
    assert.throws(() => findLicenseFile([shortLic], "TestLic"), /missing or too short/);

    const longLic = join(tempDir, "long.txt");
    writeFileSync(longLic, "A".repeat(150));
    assert.equal(findLicenseFile([longLic], "TestLic"), longLic);
  });
});

test("verifyElectronFramework uses bounded tools and pins the Electron vendor version", () => {
  withTempDir((tempDir) => {
    // SYNTHETIC mock framework: no real 200MB binary, and `strings` must NEVER be invoked
    const mockContents = join(tempDir, "mock-contents");
    const mockFw = join(mockContents, "Frameworks/Electron Framework.framework");
    mkdirSync(join(mockFw, "Resources"), { recursive: true });
    mkdirSync(join(mockContents, "MacOS"), { recursive: true });
    writeFileSync(join(mockContents, "MacOS/Sumi"), "#!/bin/sh\n");
    writeFileSync(join(mockFw, "Electron Framework"), "fake-macho");
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

    assert.equal(extractPlistString(fwPlistXml("1.2.3"), "CFBundleShortVersionString"), "1.2.3");
    assert.equal(extractPlistString(fwPlistXml("1.2.3"), "CFBundleVersion"), "1.2.3");
    assert.equal(extractPlistString("<dict></dict>", "CFBundleVersion"), null);
  });
});

test("resolvePackageLayout maps each platform to its package layout", () => {
  withTempDir((tempDir) => {
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
  });
});

function writeSileroFixture(modelsDir) {
  mkdirSync(modelsDir, { recursive: true });
  const target = join(modelsDir, "silero-vad-v6.2-F32.gguf");
  if (existsSync(realSileroPath)) {
    writeFileSync(target, readFileSync(realSileroPath));
  } else {
    writeFileSync(target, Buffer.alloc(SILERO_EXPECTED_SIZE));
  }
}

test("verifyWindowsPackage requires CRT DLLs and the Microsoft redistributable notice", () => {
  withTempDir((tempDir) => {
    const mockWinRoot = join(tempDir, "mock-win-root");
    const mockWinApp = join(mockWinRoot, "dist/sumi-win32-x64");
    const mockWinRes = join(mockWinApp, "resources");
    mkdirSync(join(mockWinRes, "runtime"), { recursive: true });
    mkdirSync(join(mockWinRes, "app"), { recursive: true });
    mkdirSync(join(mockWinRes, "licenses"), { recursive: true });

    // Sumi.exe and node.exe with valid MZ PE headers (> 1024 bytes)
    const fakePeBuffer = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(1100, 0)]);
    writeFileSync(join(mockWinApp, "Sumi.exe"), fakePeBuffer);
    writeFileSync(join(mockWinRes, "runtime/node.exe"), fakePeBuffer);

    for (const dll of WINDOWS_REQUIRED_CRT_DLLS) {
      writeFileSync(join(mockWinRes, "runtime", dll), "fake-crt-dll");
    }

    for (const lic of [
      "Trade-Journal-MIT.txt",
      "Kami-MIT.txt",
      "Node-LICENSE.txt",
      "Silero-VAD-MIT.txt",
      "Electron-LICENSE.txt",
      "THIRD-PARTY-NOTICES.md",
    ]) {
      writeFileSync(join(mockWinRes, "licenses", lic), "A".repeat(150));
    }
    writeFileSync(
      join(mockWinRes, "licenses/Microsoft-VC-Redist-LICENSE.txt"),
      "Microsoft Visual C++ Runtime Redistributable License Terms\n" + "A".repeat(100),
    );

    writeFileSync(
      join(mockWinRes, "app/package.json"),
      JSON.stringify({ main: "main.cjs", version: "0.3.0" }),
    );
    for (const f of SHELL_FILES_030) writeFileSync(join(mockWinRes, "app", f), "// shell");

    writeSileroFixture(join(mockWinRes, "server/apps/web/models"));
    writeFileSync(join(mockWinRoot, "package.json"), JSON.stringify({ version: "0.3.0" }));

    const verify = () =>
      verifyWindowsPackage({
        root: mockWinRoot,
        app: mockWinApp,
        resources: mockWinRes,
        arch: "x64",
      });

    verify();

    rmSync(join(mockWinRes, "runtime/msvcp140.dll"), { force: true });
    assert.throws(verify, /Required Windows CRT runtime DLL missing from package: msvcp140\.dll/);
    writeFileSync(join(mockWinRes, "runtime/msvcp140.dll"), "fake-crt-dll");

    rmSync(join(mockWinRes, "licenses/Microsoft-VC-Redist-LICENSE.txt"), { force: true });
    assert.throws(
      verify,
      /Microsoft Visual C\+\+ Redistributable license notice missing required terms/,
    );
  });
});

test("verifyLinuxPackage requires chrome-sandbox; runNativeAsrDoctor runs the bundled node in the web dir", () => {
  withTempDir((tempDir) => {
    const mockLinuxRoot = join(tempDir, "mock-linux-root");
    const mockLinuxApp = join(mockLinuxRoot, "dist/sumi-linux-x64");
    const mockLinuxRes = join(mockLinuxApp, "resources");
    mkdirSync(join(mockLinuxRes, "runtime"), { recursive: true });

    // sumi and node with valid ELF magic bytes (\x7fELF)
    const fakeElfBuffer = Buffer.concat([
      Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
      Buffer.alloc(1100, 0),
    ]);
    writeFileSync(join(mockLinuxApp, "sumi"), fakeElfBuffer);
    writeFileSync(join(mockLinuxRes, "runtime/node"), fakeElfBuffer);

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

    // Native ASR doctor with a synthetic runner
    const mockDoctorRoot = join(tempDir, "mock-doctor-root");
    const mockDoctorLayout = resolvePackageLayout(mockDoctorRoot, "linux", "x64");
    mkdirSync(dirname(mockDoctorLayout.nodeExecutable), { recursive: true });
    writeFileSync(mockDoctorLayout.nodeExecutable, "#!/bin/sh\n");
    writeSileroFixture(join(mockDoctorLayout.webDir, "models"));
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
  });
});
