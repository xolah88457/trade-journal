import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const app = join(root, "dist/Sumi.app/Contents");
const resources = join(app, "Resources");
const node = join(resources, "runtime/node");

async function start(dataDirectory) {
  const child = spawn(node, [join(resources, "launch.cjs")], {
    cwd: dataDirectory,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: process.env.HOME,
      TMPDIR: tmpdir(),
      JOURNAL_DATA_DIR: dataDirectory,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Startup timed out:\n${output}`)), 65000);
    const receive = (chunk) => {
      output += chunk.toString();
      const match = output.match(/SUMI_READY (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    child.stdout.on("data", receive);
    child.stderr.on("data", receive);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited ${code}:\n${output}`));
    });
  });
  const stop = async () => {
    if (child.exitCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const timeout = setTimeout(() => child.kill("SIGKILL"), 4000);
    await exited;
    clearTimeout(timeout);
  };
  try {
    return { origin: await ready, stop, child };
  } catch (error) {
    await stop();
    throw error;
  }
}

function checkNoPrivateFiles(directory) {
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

function checkSelfContainedSymlinks(directory, basePrefix) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const real = realpathSync(path);
      assert.ok(
        real.startsWith(basePrefix),
        `Symlink escapes application bundle into developer checkout: ${path} -> ${real}`,
      );
    } else if (entry.isDirectory()) {
      checkSelfContainedSymlinks(path, basePrefix);
    }
  }
}

test("the app is signed, self-contained, and contains no development journal", () => {
  assert.ok(existsSync(join(app, "MacOS/Sumi")), "Run pnpm desktop:build first.");
  assert.ok(existsSync(join(resources, "Sumi.icns")), "Application icon Sumi.icns missing.");
  execFileSync("plutil", ["-lint", join(app, "Info.plist")]);
  const plist = readFileSync(join(app, "Info.plist"), "utf8");
  assert.match(plist, /<key>CFBundleIconFile<\/key>\s*<string>Sumi<\/string>/);
  assert.match(
    plist,
    /<key>NSMicrophoneUsageDescription<\/key>\s*<string>[^<]+<\/string>/,
    "Info.plist must contain NSMicrophoneUsageDescription",
  );
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
  execFileSync("codesign", ["--verify", "--deep", "--strict", join(app, "..")]);
  const linked = execFileSync("otool", ["-L", node], { encoding: "utf8" });
  assert.doesNotMatch(linked, /\/opt\/homebrew|\/usr\/local\/opt/);
  for (const file of [
    "Trade-Journal-MIT.txt",
    "Kami-MIT.txt",
    "Node-LICENSE.txt",
    "Silero-VAD-MIT.txt",
  ]) {
    assert.ok(readFileSync(join(resources, "licenses", file), "utf8").length > 100);
  }
  // Verify only the small Silero VAD asset is bundled with exact SHA256, and no heavy ASR weights exist
  const bundledSilero = join(resources, "server/apps/web/models/silero-vad-v6.2-F32.gguf");
  assert.ok(
    existsSync(bundledSilero),
    "Bundled Silero VAD model missing at server/apps/web/models/silero-vad-v6.2-F32.gguf",
  );
  const sileroBytes = readFileSync(bundledSilero);
  assert.equal(sileroBytes.length, 1241056, "Bundled Silero VAD size mismatch");
  const sileroHash = createHash("sha256").update(sileroBytes).digest("hex");
  assert.equal(
    sileroHash,
    "0d871a800c420fdd5d1b17a3aea4296d1c39608f0ff4a9295eb76457eb1c88e6",
    "Bundled Silero VAD checksum mismatch",
  );
  assert.ok(
    !existsSync(join(resources, "server/apps/web/models/parakeet-unified-en-0.6b-Q8_0.gguf")),
    "Parakeet ASR weights must never be bundled inside .app",
  );
  const rootPkg = JSON.parse(readFileSync(join(resources, "package.json"), "utf8"));
  assert.equal(rootPkg.type, "commonjs");
  assert.equal(rootPkg.private, true);
  checkNoPrivateFiles(join(resources, "server"));
  const serverReal = realpathSync(join(resources, "server")) + "/";
  checkSelfContainedSymlinks(join(resources, "server"), serverReal);
});

test(
  "bundled server starts, serves every journal screen, and persists SQLite across restarts",
  { timeout: 150000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "sumi-check-"));
    let server;
    try {
      server = await start(directory);
      const port = Number(new URL(server.origin).port);
      assert.notEqual(port, 3000, "Server must bind to an ephemeral port, not default 3000");

      for (const path of [
        "/",
        "/accounts",
        "/trades",
        "/calendar",
        "/journal",
        "/reports",
        "/settings",
        "/notebook",
        "/playbooks",
        "/progress",
        "/missed",
        "/prop-firms",
        "/import",
      ]) {
        const response = await fetch(server.origin + path);
        assert.equal(response.status, 200, path);
        const html = await response.text();
        assert.match(html, /Sumi/);
        if (path === "/") assert.doesNotMatch(html, /<html[^>]*class="dark"/);
      }
      const voiceRes = await fetch(server.origin + "/api/voice/status");
      assert.equal(voiceRes.status, 200);
      const voiceStatus = await voiceRes.json();
      assert.equal(voiceStatus.activeModel, "parakeet-unified-en-0.6b");
      const created = await fetch(server.origin + "/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: server.origin },
        body: JSON.stringify({
          name: "Desktop persistence check",
          kind: "manual",
          initialBalance: 10000,
        }),
      });
      assert.equal(created.status, 200);
      const { id } = await created.json();
      assert.ok(id);
      assert.ok(existsSync(join(directory, "journal.db")));
      const oldOrigin = server.origin;
      await server.stop();
      await assert.rejects(fetch(oldOrigin, { signal: AbortSignal.timeout(2000) }));
      server = await start(directory);
      const response = await fetch(server.origin + "/api/accounts");
      const { accounts } = await response.json();
      assert.equal(
        accounts.find((account) => account.id === id)?.name,
        "Desktop persistence check",
      );
    } finally {
      await server?.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "concurrent isolated servers bind to distinct ephemeral ports without collision",
  { timeout: 150000 },
  async () => {
    const dir1 = mkdtempSync(join(tmpdir(), "sumi-check-1-"));
    const dir2 = mkdtempSync(join(tmpdir(), "sumi-check-2-"));
    let server1;
    let server2;
    try {
      [server1, server2] = await Promise.all([start(dir1), start(dir2)]);
      const port1 = Number(new URL(server1.origin).port);
      const port2 = Number(new URL(server2.origin).port);
      assert.notEqual(port1, 3000);
      assert.notEqual(port2, 3000);
      assert.notEqual(
        port1,
        port2,
        `Concurrent instances must have different ports: ${port1} vs ${port2}`,
      );
      const [res1, res2] = await Promise.all([
        fetch(server1.origin + "/"),
        fetch(server2.origin + "/"),
      ]);
      assert.equal(res1.status, 200);
      assert.equal(res2.status, 200);
    } finally {
      await Promise.allSettled([server1?.stop(), server2?.stop()]);
      rmSync(dir1, { recursive: true, force: true });
      rmSync(dir2, { recursive: true, force: true });
    }
  },
);
