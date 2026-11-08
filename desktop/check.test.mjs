import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  checkNoPrivateFiles,
  checkSelfContainedSymlinks,
  resolvePackageLayout,
  runNativeAsrDoctor,
  verifyElectronPackage,
  verifyPackageForPlatform,
} from "./check-support.mjs";

const require = createRequire(import.meta.url);
const { buildChildEnv } = require("./main.cjs");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const layout = resolvePackageLayout(root);

async function start(dataDirectory) {
  const env = buildChildEnv(dataDirectory);
  if (process.platform === "win32") {
    env.PATH = `${join(layout.resources, "runtime")};${env.PATH || ""}`;
  }

  const child = spawn(layout.nodeExecutable, [layout.launchScript], {
    cwd: dataDirectory,
    env,
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

test("the app package is verified, structurally compliant, and contains no development journal", () => {
  verifyPackageForPlatform({ root });
});

test("native ASR backend doctor: loads packaged transcribe-cpp and executes Silero VAD silence inference with bundled Node", () => {
  const result = runNativeAsrDoctor({ root });
  assert.equal(result.success, true);
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
