import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stopChildProcess } from "./main.cjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("graceful child shutdown sends SIGTERM and bounds with SIGKILL", async () => {
  const isWin = process.platform === "win32";
  // Spawn a child process that signals readiness then traps SIGTERM / ignores IPC
  const child = spawn(
    process.execPath,
    [
      "-e",
      'process.on("SIGTERM", () => {}); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);',
    ],
    { stdio: ["ignore", "pipe", "ignore", isWin ? "ipc" : "ignore"] },
  );

  // Wait until child has attached its SIGTERM handler
  await new Promise((resolve) => {
    child.stdout.once("data", () => resolve());
  });

  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);

  const start = Date.now();
  const result1 = await stopChildProcess(child, {
    timeoutMs: 300,
    platform: process.platform,
    ...(isWin ? { killProcessTree: () => child.kill("SIGKILL") } : {}),
  });
  const elapsed = Date.now() - start;

  assert.equal(result1, "killed");
  // Killed by bounded watchdog within timeout (~300ms)
  assert.ok(elapsed >= 250 && elapsed < 2000);

  // Calling stop again guarded against double shutdown
  const result2 = await stopChildProcess(child, {
    timeoutMs: 300,
    platform: process.platform,
    ...(isWin ? { killProcessTree: () => child.kill("SIGKILL") } : {}),
  });
  assert.equal(result2, "already_exited");
});

test("late child exit detection when not shutting down", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(42);"], {
    stdio: "ignore",
  });

  let unexpectedExitCode = null;
  let unexpectedSignal = null;
  const isStopping = false;

  child.once("exit", (code, signal) => {
    if (!isStopping) {
      unexpectedExitCode = code;
      unexpectedSignal = signal;
    }
  });

  await once(child, "exit");
  assert.equal(unexpectedExitCode, 42);
  assert.equal(unexpectedSignal, null);
});

test("stopChildProcess sends parent-owned IPC shutdown message and child exits cleanly", async () => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      'process.on("message", (m) => { if (m?.type === "sumi:shutdown") process.exit(0); }); setInterval(() => {}, 1000);',
    ],
    { stdio: ["ignore", "pipe", "ignore", "ipc"] },
  );

  const result = await stopChildProcess(child, { platform: "win32", timeoutMs: 1500 });
  assert.equal(result, "stopped");
  assert.equal(child.exitCode, 0);
});

test("stopChildProcess in win32 mode avoids SIGTERM and invokes killProcessTree on timeout", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
    stdio: ["ignore", "pipe", "ignore", "ipc"],
  });

  let treeKilledPid = null;
  const result = await stopChildProcess(child, {
    platform: "win32",
    timeoutMs: 200,
    killProcessTree: (pid) => {
      treeKilledPid = pid;
      child.kill("SIGKILL");
    },
  });

  assert.ok(result === "stopped" || result === "killed");
  assert.equal(treeKilledPid, child.pid);
});

test("launch.cjs responds to parent-owned IPC shutdown message and exits 0", async () => {
  const launchScript = path.join(__dirname, "launch.cjs");
  const child = spawn(process.execPath, [launchScript], {
    env: { ...process.env, SUMI_TEST_MODE: "1", PORT: "0" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });

  const exitPromise = once(child, "exit");
  child.send({ type: "sumi:shutdown" });
  const [code] = await exitPromise;
  assert.equal(code, 0);
});

test("launch.cjs terminates automatically on IPC disconnect", async () => {
  const launchScript = path.join(__dirname, "launch.cjs");
  const child = spawn(process.execPath, [launchScript], {
    env: { ...process.env, SUMI_TEST_MODE: "1", PORT: "0" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });

  const exitPromise = once(child, "exit");
  child.disconnect();
  const [code] = await exitPromise;
  assert.equal(code, 0);
});

test("launch.cjs dispatches async SIGTERM server cleanup on parent IPC shutdown and allows marker write", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-stub-"));
  const markerPath = path.join(tmpDir, "cleanup-marker.json");
  const stubServerPath = path.join(tmpDir, "async-sigterm-server.cjs");

  try {
    fs.writeFileSync(
      stubServerPath,
      `
      const fs = require("node:fs");
      process.on("SIGTERM", async () => {
        // Simulate Next.js async cleanup (closing database, sockets, etc.)
        await new Promise((resolve) => setTimeout(resolve, 150));
        fs.writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({ cleanedUp: true }), "utf8");
        process.exit(0);
      });
      process.stdout.write("server_ready\\n");
      setInterval(() => {}, 1000);
      `,
      "utf8",
    );

    const launchScript = path.join(__dirname, "launch.cjs");
    const child = spawn(process.execPath, [launchScript], {
      env: {
        ...process.env,
        SUMI_TEST_MODE: "1",
        SUMI_SERVER_PATH: stubServerPath,
        PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });

    // Wait until server has registered its SIGTERM listener
    await new Promise((resolve) => {
      child.stdout.once("data", () => resolve());
    });

    const exitPromise = once(child, "exit");
    child.send({ type: "sumi:shutdown" });
    const [code] = await exitPromise;

    assert.equal(code, 0);
    assert.equal(fs.existsSync(markerPath), true, "Async cleanup marker file must exist");
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    assert.equal(marker.cleanedUp, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("stopChildProcess parent watchdog remains bounded and forces shutdown if server SIGTERM hangs", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-hang-"));
  const hangingServerPath = path.join(tmpDir, "hanging-server.cjs");

  try {
    fs.writeFileSync(
      hangingServerPath,
      `
      process.on("SIGTERM", () => {
        // Hang indefinitely and never call process.exit
      });
      process.stdout.write("hanging_ready\\n");
      setInterval(() => {}, 1000);
      `,
      "utf8",
    );

    const launchScript = path.join(__dirname, "launch.cjs");
    const child = spawn(process.execPath, [launchScript], {
      env: {
        ...process.env,
        SUMI_TEST_MODE: "1",
        SUMI_SERVER_PATH: hangingServerPath,
        PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });

    await new Promise((resolve) => {
      child.stdout.once("data", () => resolve());
    });

    const start = Date.now();
    const result = await stopChildProcess(child, { timeoutMs: 300 });
    const elapsed = Date.now() - start;

    assert.equal(result, "killed");
    assert.ok(
      elapsed >= 250 && elapsed < 2000,
      `Watchdog must enforce bounded timeout (~300ms), got ${elapsed}ms`,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("SUMI_SERVER_PATH override is ignored in production (SUMI_TEST_MODE !== 1)", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-override-"));
  const markerPath = path.join(tmpDir, "unauthorized-marker.txt");
  const unauthorizedServerPath = path.join(tmpDir, "unauthorized-server.cjs");

  try {
    fs.writeFileSync(
      unauthorizedServerPath,
      `
      const fs = require("node:fs");
      fs.writeFileSync(${JSON.stringify(markerPath)}, "should-not-run", "utf8");
      `,
      "utf8",
    );

    const launchScript = path.join(__dirname, "launch.cjs");
    const childEnv = { ...process.env, SUMI_SERVER_PATH: unauthorizedServerPath };
    delete childEnv.SUMI_TEST_MODE;

    const child = spawn(process.execPath, [launchScript], {
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    const [code] = await once(child, "exit");

    // Must exit with error because fixed bundled server is missing in dev checkout
    assert.equal(code, 1);
    const expectedServerSubpath = path.join("server", "apps", "web", "server.js");
    assert.ok(
      stderr.includes(expectedServerSubpath) ||
        stderr.includes("server/apps/web/server.js") ||
        stderr.includes("server\\apps\\web\\server.js"),
      `Must fail attempting to load official fixed bundled server, got: ${stderr}`,
    );
    // Unauthorized server must NEVER have been executed
    assert.equal(fs.existsSync(markerPath), false, "Unauthorized server must NOT execute");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

function runLaunchWithFakeServer({ preload } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-launch-"));
  const dataDir = path.join(tmpDir, "data");
  fs.mkdirSync(dataDir, { mode: 0o700 });
  const serverPath = path.join(tmpDir, "fake-server.cjs");
  const hitsPath = path.join(tmpDir, "hits.txt");
  fs.writeFileSync(
    serverPath,
    `
    const http = require("node:http");
    const fs = require("node:fs");
    const server = http.createServer((req, res) => {
      fs.appendFileSync(${JSON.stringify(hitsPath)}, req.url + "\\n");
      res.statusCode = req.url === "/api/health" ? 401 : 500;
      res.end("x");
    });
    server.listen(0, "127.0.0.1", () => {
      process.env.PORT = String(server.address().port);
    });
    `,
  );
  const args = [];
  if (preload) {
    const preloadPath = path.join(tmpDir, "preload.cjs");
    fs.writeFileSync(preloadPath, preload);
    args.push("--require", preloadPath);
  }
  args.push(path.join(__dirname, "launch.cjs"));
  const child = spawn(process.execPath, args, {
    env: {
      ...process.env,
      SUMI_TEST_MODE: "1",
      SUMI_SERVER_PATH: serverPath,
      JOURNAL_DATA_DIR: dataDir,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  return { child, tmpDir, dataDir, hitsPath };
}

function waitForReady(child) {
  let out = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no SUMI_READY: ${out}`)), 15000);
    child.stdout.on("data", (d) => {
      out += d.toString();
      if (/SUMI_READY http:\/\/127\.0\.0\.1:\d+/.test(out)) {
        clearTimeout(timer);
        resolve(out);
      }
    });
    child.once("exit", () => reject(new Error(`exited early: ${out}`)));
  });
}

async function cleanupLaunch({ child, tmpDir }) {
  const exit = once(child, "exit");
  child.kill("SIGKILL");
  await exit;
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

test("launch.cjs probes /api/health (any non-5xx counts as ready) and not /", async () => {
  const run = runLaunchWithFakeServer();
  try {
    await waitForReady(run.child);
    const hits = fs.readFileSync(run.hitsPath, "utf8").trim().split("\n");
    assert.ok(hits.length >= 1);
    assert.ok(
      hits.every((h) => h === "/api/health"),
      `unexpected probes: ${hits}`,
    );
  } finally {
    await cleanupLaunch(run);
  }
});

test("launch.cjs enables a private compile cache inside the data dir when supported", async () => {
  const run = runLaunchWithFakeServer({
    preload: `
      require("node:module").enableCompileCache = (dir) => {
        require("node:fs").writeFileSync(process.env.JOURNAL_DATA_DIR + "/cache-arg.txt", dir);
      };
    `,
  });
  try {
    await waitForReady(run.child);
    const cacheDir = path.join(run.dataDir, ".node-cache");
    assert.equal(fs.readFileSync(path.join(run.dataDir, "cache-arg.txt"), "utf8"), cacheDir);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(cacheDir).mode & 0o777, 0o700);
    }
  } finally {
    await cleanupLaunch(run);
  }
});

test("launch.cjs tolerates a missing or throwing enableCompileCache", async () => {
  for (const body of [
    `require("node:module").enableCompileCache = undefined;`,
    `require("node:module").enableCompileCache = () => { throw new Error("nope"); };`,
  ]) {
    const run = runLaunchWithFakeServer({ preload: body });
    try {
      await waitForReady(run.child);
    } finally {
      await cleanupLaunch(run);
    }
  }
});
