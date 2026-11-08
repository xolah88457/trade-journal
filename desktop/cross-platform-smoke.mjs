import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Parses DevTools CDP port from Electron's stderr output.
 */
export function parseDevToolsPort(stderr) {
  const m =
    typeof stderr === "string" &&
    stderr.match(/DevTools listening on ws:\/\/(?:127\.0\.0\.1|\[::1\]|localhost):(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Reads DevTools CDP port from Chromium's DevToolsActivePort file (line 1).
 */
export function readDevToolsActivePort(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    const port = parseInt(raw.split(/\r?\n/)[0], 10);
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

/**
 * Parses Node.js V8 inspector WebSocket URL from Electron's stderr output.
 */
export function parseNodeInspectorUrl(stderr) {
  if (typeof stderr !== "string") return null;
  const match = stderr.match(
    /Debugger listening on (ws:\/\/(?:127\.0\.0\.1|\[::1\]|localhost):\d+\/[a-zA-Z0-9-]+)/i,
  );
  return match ? match[1] : null;
}

/**
 * Removes stale DevToolsActivePort file before spawning Electron.
 * Prevents relaunch from reading previous run's port before new port is ready.
 */
export function cleanStaleDevToolsActivePort(dataDir) {
  const portFile = path.join(dataDir, "electron", "DevToolsActivePort");
  try {
    if (fs.existsSync(portFile)) fs.unlinkSync(portFile);
  } catch {}
}

/**
 * Minimal Chrome DevTools Protocol (CDP) WebSocket client.
 */
export class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.id = 1;
    this.pending = new Map();
    this.closed = false;

    ws.onmessage = (e) => {
      try {
        const { id, result, error } = JSON.parse(e.data);
        const req = id && this.pending.get(id);
        if (req) {
          clearTimeout(req.t);
          this.pending.delete(id);
          error
            ? req.reject(new Error(`CDP ${error.code}: ${error.message}`))
            : req.resolve(result);
        }
      } catch {}
    };
    ws.onclose = () => {
      this.closed = true;
      for (const req of this.pending.values()) {
        clearTimeout(req.t);
        req.reject(new Error("CDP connection closed"));
      }
      this.pending.clear();
    };
    ws.onerror = () => {};
  }

  send(method, params = {}, timeoutMs = 15000) {
    if (this.closed) return Promise.reject(new Error("CDP connection closed"));
    return new Promise((resolve, reject) => {
      const id = this.id++;
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method} (${id})`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, t });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression, timeoutMs = 15000) {
    const res = await this.send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      timeoutMs,
    );
    if (res?.exceptionDetails) {
      const desc =
        res.exceptionDetails.exception?.description ||
        res.exceptionDetails.text ||
        "CDP eval failed";
      throw new Error(`Runtime.evaluate: ${desc}`);
    }
    return res?.result?.value;
  }

  close() {
    this.closed = true;
    try {
      this.ws.close();
    } catch {}
  }
}

export async function poll(fn, timeoutMs = 20000, intervalMs = 200, label = "condition") {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fn();
      if (r) return r;
    } catch {}
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label} (${timeoutMs}ms)`);
}

export const waitForCondition = (cdp, expr, ms = 20000) =>
  poll(async () => Boolean(await cdp.eval(`Boolean(${expr})`, 2000)), ms, 250, expr);

export const waitForOrigin = (cdp, ms = 60000) =>
  poll(
    async () => {
      const o = await cdp.eval("window.location.origin", 2000);
      return typeof o === "string" && o.startsWith("http://127.0.0.1:") ? o : null;
    },
    ms,
    250,
    "loopback origin",
  );

/**
 * Awaits full DOM readiness and trusted loopback origin in the renderer.
 * Guards against executing DOM-dependent evaluations (e.g. Blob anchor clicks)
 * while a page reload is in-flight or before document.body is attached.
 */
export const waitForDomReady = (cdp, expectedOrigin = null, ms = 20000) =>
  waitForCondition(
    cdp,
    `Boolean(document && document.body) && ` +
      `(document.readyState === 'complete' || document.readyState === 'interactive') && ` +
      `typeof window.location?.origin === 'string' && ` +
      (expectedOrigin
        ? `window.location.origin === ${JSON.stringify(expectedOrigin)}`
        : `window.location.origin.startsWith('http://127.0.0.1:')`),
    ms,
  );

export const waitForFileContent = (file, pred, ms = 15000) =>
  poll(() => fs.existsSync(file) && pred(fs.readFileSync(file, "utf8")), ms, 200, file);

export async function waitForProcessExit(child, ms = 15000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    child.once("exit", () => {
      clearTimeout(t);
      resolve(true);
    });
  });
}

export async function verifyBackendUnreachable(origin, ms = 6000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      await fetch(origin, { signal: AbortSignal.timeout(1000) });
      await new Promise((r) => setTimeout(r, 200));
    } catch {
      return true;
    }
  }
  return false;
}

export async function stopProcessTree(child, ms = 4000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exit = new Promise((resolve) => child.once("exit", resolve));
  if (process.platform !== "win32") {
    try {
      child.kill("SIGTERM");
    } catch {}
  }
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      if (process.platform === "win32") {
        try {
          execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        } catch {
          try {
            child.kill();
          } catch {}
        }
      } else {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
    }
  }, ms);
  await exit;
  clearTimeout(timer);
}

export function launchApp(appPath, dataDir, dlDir) {
  cleanStaleDevToolsActivePort(dataDir);
  const isWinOrLinux = process.platform === "win32" || process.platform === "linux";
  const args = ["--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1"];
  if (isWinOrLinux) {
    args.push("--inspect=127.0.0.1:0");
  }
  const env = {
    ...process.env,
    SUMI_TEST_MODE: "1",
    JOURNAL_DATA_DIR: dataDir,
    SUMI_TEST_DOWNLOAD_DIR: dlDir,
  };
  const child = spawn(appPath, args, {
    cwd: dataDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdoutBuf = "",
    stderrBuf = "";
  child.stdout.on("data", (d) => {
    stdoutBuf = (stdoutBuf + d.toString("utf8")).slice(-32768);
  });
  child.stderr.on("data", (d) => {
    stderrBuf = (stderrBuf + d.toString("utf8")).slice(-32768);
  });
  return { child, getStdout: () => stdoutBuf, getStderr: () => stderrBuf };
}

export const waitForCdpPort = (inst, dataDir, ms = 30000) =>
  poll(
    () => {
      if (inst.child.exitCode !== null || inst.child.signalCode !== null) {
        throw new Error(
          `Child exited prematurely: code=${inst.child.exitCode} sig=${inst.child.signalCode}`,
        );
      }
      return (
        parseDevToolsPort(inst.getStderr()) ||
        readDevToolsActivePort(path.join(dataDir, "electron", "DevToolsActivePort"))
      );
    },
    ms,
    200,
    "DevTools port",
  );

export const waitForNodeInspectorUrl = (inst, ms = 30000) =>
  poll(
    () => {
      if (inst.child.exitCode !== null || inst.child.signalCode !== null) {
        throw new Error(
          `Child exited prematurely: code=${inst.child.exitCode} sig=${inst.child.signalCode}`,
        );
      }
      return parseNodeInspectorUrl(inst.getStderr());
    },
    ms,
    200,
    "Node inspector URL",
  );

export const findPageTarget = (port, ms = 20000) =>
  poll(
    async () => {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) return null;
      const list = await res.json();
      return list.find((t) => t.type === "page" && t.webSocketDebuggerUrl) || null;
    },
    ms,
    200,
    `page target on ${port}`,
  );

export function connectCdp(wsUrl, ms = 10000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const t = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      reject(new Error(`WS timeout: ${wsUrl}`));
    }, ms);
    ws.onopen = () => {
      clearTimeout(t);
      resolve(new CdpClient(ws));
    };
    ws.onerror = (e) => {
      clearTimeout(t);
      reject(new Error(`WS error: ${e?.message || e}`));
    };
  });
}

/**
 * Verifies packaged runtime SDK closure of electron-updater in main process on Win/Linux.
 * Evaluates autoUpdater via process.mainModule.require, asserts required methods,
 * disables background polling/download, and closes inspector connection.
 */
export async function verifyPackagedUpdaterClosure(inspectorWsUrl) {
  const inspectorCdp = await connectCdp(inspectorWsUrl);
  try {
    const expr = `(() => {
      const req = (typeof process !== "undefined" && process.mainModule && process.mainModule.require)
        ? process.mainModule.require.bind(process.mainModule)
        : (typeof require === "function" ? require : null);
      if (!req) {
        throw new Error("Node inspector require unavailable in main process (process.mainModule.require missing)");
      }
      const updaterModule = req("electron-updater");
      const autoUpdater = updaterModule?.autoUpdater || updaterModule;
      if (!autoUpdater) {
        throw new Error("electron-updater.autoUpdater not exported");
      }
      if (
        typeof autoUpdater.checkForUpdates !== "function" ||
        typeof autoUpdater.downloadUpdate !== "function" ||
        typeof autoUpdater.quitAndInstall !== "function"
      ) {
        throw new Error("electron-updater.autoUpdater missing required update lifecycle methods");
      }
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = false;
      return true;
    })()`;
    const ok = await inspectorCdp.eval(expr);
    assert.equal(ok, true, "Updater SDK verification must return true");
  } finally {
    inspectorCdp.close();
  }
}

export async function runSmokeTest(customAppPath) {
  const appPath = customAppPath || process.env.SUMI_SMOKE_APP;
  if (!appPath) {
    throw new Error(
      "Contract violation: SUMI_SMOKE_APP environment variable must point to the packaged application executable.",
    );
  }
  if (!path.isAbsolute(appPath)) {
    throw new Error(`Contract violation: SUMI_SMOKE_APP must be an absolute path: ${appPath}`);
  }
  if (!fs.existsSync(appPath)) {
    throw new Error(`Packaged application binary not found at: ${appPath}`);
  }

  console.log(`[smoke] Starting cross-platform smoke on: ${appPath}`);
  const baseTmp = fs.realpathSync(os.tmpdir());
  const tempDir = fs.mkdtempSync(path.join(baseTmp, "sumi-smoke-"));
  const canonicalTempDir = fs.realpathSync(tempDir);
  const downloadDir = path.join(canonicalTempDir, "downloads");
  fs.mkdirSync(downloadDir, { recursive: true, mode: 0o700 });

  const activeInstances = [];
  let holdServer = null;

  try {
    // Stage 1: Setup isolated temp environment & launch instance 1
    const inst1 = launchApp(appPath, canonicalTempDir, downloadDir);
    activeInstances.push(inst1);
    const cdpPort1 = await waitForCdpPort(inst1, canonicalTempDir);
    console.log(
      `[smoke] PASS Stage 1: App launched (PID ${inst1.child.pid}), CDP active on port ${cdpPort1}`,
    );

    // If running on Windows or Linux, verify packaged electron-updater SDK closure via Node inspector
    if (process.platform === "win32" || process.platform === "linux") {
      const inspectorWsUrl = await waitForNodeInspectorUrl(inst1);
      await verifyPackagedUpdaterClosure(inspectorWsUrl);
      console.log(
        "[smoke] PASS Stage 1b: Verified packaged electron-updater closure in main process",
      );
    }

    // Stage 2: Connect CDP, await loopback origin, assert security boundary & sumiDesktop bridge
    const pageTarget1 = await findPageTarget(cdpPort1);
    const cdp1 = await connectCdp(pageTarget1.webSocketDebuggerUrl);
    const origin1 = await waitForOrigin(cdp1);
    assert.ok(origin1.startsWith("http://127.0.0.1:"), `Invalid origin: ${origin1}`);

    await waitForCondition(cdp1, "window.sumiDesktop", 30000);

    const ua = await cdp1.eval("navigator.userAgent");
    assert.ok(ua.includes("Electron/45.2.3"), `UA missing Electron/45.2.3: ${ua}`);
    assert.equal(await cdp1.eval("typeof window.require"), "undefined", "window.require exposed");
    assert.equal(await cdp1.eval("typeof window.process"), "undefined", "window.process exposed");

    const bridgeKeys = await cdp1.eval("Object.keys(window.sumiDesktop || {}).sort()");
    assert.deepEqual(bridgeKeys, ["checkForUpdates", "getInfo", "preferences", "savePreferences"]);

    const rootPkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const expectedAppVersion = rootPkg.version;

    const info = await cdp1.eval("window.sumiDesktop.getInfo()");
    assert.equal(info.version, expectedAppVersion, "info.version mismatch");
    assert.equal(info.platform, process.platform, "info.platform mismatch");
    assert.equal(info.arch, process.arch, "info.arch mismatch");
    assert.ok(
      typeof info.electronVersion === "string" && info.electronVersion.startsWith("45."),
      "electronVersion not 45.x",
    );
    console.log(
      "[smoke] PASS Stage 2: Loopback origin reached, verified Electron 45.2.3 UA and sumiDesktop bridge",
    );

    // Stage 3: Create SQLite manual account
    const postRes = await fetch(`${origin1}/api/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Smoke Manual Account", kind: "manual" }),
    });
    assert.equal(postRes.status, 200, `POST /api/accounts status ${postRes.status}`);
    const account = await postRes.json();
    assert.ok(account?.id, "POST /api/accounts returned no account ID");
    const accountId = account.id;

    const getRes = await fetch(`${origin1}/api/accounts`);
    assert.equal(getRes.status, 200, `GET /api/accounts status ${getRes.status}`);
    const accountsData = await getRes.json();
    assert.ok(
      Array.isArray(accountsData.accounts) && accountsData.accounts.some((a) => a.id === accountId),
      `Account ${accountId} not in GET /api/accounts`,
    );
    console.log(
      `[smoke] PASS Stage 3: Ephemeral backend ready at ${origin1}, manual account ${accountId} created in SQLite`,
    );

    // Stage 4: Preferences sync and reload verification
    await cdp1.eval("localStorage.setItem('journal-theme-v1', 'dark');");
    const prefsPath = path.join(canonicalTempDir, "preferences.json");
    await waitForFileContent(
      prefsPath,
      (raw) => {
        try {
          return JSON.parse(raw)["journal-theme-v1"] === "dark";
        } catch {
          return false;
        }
      },
      10000,
    );

    // Mark pre-reload state to prevent stale evaluation race
    await cdp1.eval("window.__sumiSmokePreReload = true;").catch(() => {});
    try {
      await cdp1.send("Page.reload");
    } catch {
      await cdp1.eval("location.reload();").catch(() => {});
    }

    // Await navigation completion: fresh context (no pre-reload marker), trusted loopback origin,
    // DOM readiness (document.body present), and restored preferences in localStorage and bridge
    await waitForCondition(
      cdp1,
      `!window.__sumiSmokePreReload && ` +
        `window.location.origin === ${JSON.stringify(origin1)} && ` +
        `Boolean(document && document.body) && ` +
        `(document.readyState === 'complete' || document.readyState === 'interactive') && ` +
        `Boolean(window.sumiDesktop) && ` +
        `localStorage.getItem('journal-theme-v1') === 'dark' && ` +
        `window.sumiDesktop.preferences?.['journal-theme-v1'] === 'dark'`,
      15000,
    );
    console.log(
      "[smoke] PASS Stage 4: Preferences persisted to disk and restored across page reload",
    );

    // Stage 5: Native download flow via DOM Blob anchor click
    await waitForDomReady(cdp1, origin1, 15000);
    const downloadFileName = "smoke-export.txt";
    const downloadText = "sumi-cross-platform-smoke-download-verified";
    await cdp1.eval(`(() => {
      const target = document.body || document.documentElement;
      if (!target) {
        throw new Error("Cannot append download anchor: document body is null");
      }
      const blob = new Blob([${JSON.stringify(downloadText)}], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = ${JSON.stringify(downloadFileName)};
      target.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    })()`);

    const downloadedFilePath = path.join(downloadDir, downloadFileName);
    await waitForFileContent(downloadedFilePath, (text) => text === downloadText, 15000);
    console.log(
      "[smoke] PASS Stage 5: Native file download smoke test verified via DOM anchor click",
    );

    // Stage 6: Graceful quit renderer & await backend stop
    try {
      await cdp1.eval("window.close();");
    } catch {}
    cdp1.close();
    assert.ok(
      await waitForProcessExit(inst1.child, 15000),
      "Instance 1 did not exit cleanly within 15s",
    );
    assert.ok(
      await verifyBackendUnreachable(origin1, 8000),
      `Backend at ${origin1} remained reachable`,
    );

    // Hold old backend port occupied with net server to prove deterministic port rotation
    const oldPort = parseInt(new URL(origin1).port, 10);
    if (oldPort > 0) {
      try {
        holdServer = net.createServer();
        await new Promise((resolve, reject) => {
          holdServer.once("error", reject);
          holdServer.listen(oldPort, "127.0.0.1", () => resolve());
        });
      } catch {
        holdServer = null;
      }
    }
    console.log(
      "[smoke] PASS Stage 6: Graceful quit verified; backend stopped; old port held for rotation check",
    );

    // Stage 7: Relaunch with SAME temp directory; assert SQLite, preferences, and port rotation
    const inst2 = launchApp(appPath, canonicalTempDir, downloadDir);
    activeInstances.push(inst2);
    const cdpPort2 = await waitForCdpPort(inst2, canonicalTempDir);
    const pageTarget2 = await findPageTarget(cdpPort2);
    const cdp2 = await connectCdp(pageTarget2.webSocketDebuggerUrl);

    const origin2 = await waitForOrigin(cdp2);
    assert.notEqual(origin2, origin1, `Backend port did not rotate: ${origin2} === ${origin1}`);
    if (holdServer) {
      try {
        holdServer.close();
      } catch {}
      holdServer = null;
    }

    const getRes2 = await fetch(`${origin2}/api/accounts`);
    assert.equal(getRes2.status, 200, `GET /api/accounts on relaunch status ${getRes2.status}`);
    const accountsData2 = await getRes2.json();
    assert.ok(
      Array.isArray(accountsData2.accounts) &&
        accountsData2.accounts.some((a) => a.id === accountId),
      `Account ${accountId} not persisted in SQLite`,
    );

    await waitForCondition(
      cdp2,
      "window.sumiDesktop && localStorage.getItem('journal-theme-v1') === 'dark' && window.sumiDesktop.preferences['journal-theme-v1'] === 'dark'",
      15000,
    );
    assert.equal(await cdp2.eval("localStorage.getItem('journal-theme-v1')"), "dark");
    assert.equal(await cdp2.eval("window.sumiDesktop.preferences['journal-theme-v1']"), "dark");
    console.log(
      "[smoke] PASS Stage 7: Relaunched with same data dir; verified SQLite persistence, preferences bootstrap, and port rotation",
    );

    // Stage 8: Second instance graceful quit
    try {
      await cdp2.eval("window.close();");
    } catch {}
    cdp2.close();
    assert.ok(
      await waitForProcessExit(inst2.child, 15000),
      "Instance 2 did not exit cleanly within 15s",
    );
    assert.ok(
      await verifyBackendUnreachable(origin2, 8000),
      `Second backend at ${origin2} remained reachable`,
    );
    console.log(
      "[smoke] PASS Stage 8: Second instance graceful shutdown verified; backend stopped",
    );

    console.log("[smoke] ALL CROSS-PLATFORM SMOKE CHECKS PASSED.");
  } catch (err) {
    console.error(`\n[smoke] SMOKE TEST FAILED: ${err.message}`);
    for (let i = 0; i < activeInstances.length; i++) {
      const inst = activeInstances[i];
      const stderr = inst.getStderr().trim();
      const stdout = inst.getStdout().trim();
      if (stderr)
        console.error(
          `[smoke] --- Instance ${i + 1} stderr (last 4000 chars) ---\n${stderr.slice(-4000)}`,
        );
      if (stdout)
        console.error(
          `[smoke] --- Instance ${i + 1} stdout (last 4000 chars) ---\n${stdout.slice(-4000)}`,
        );
    }
    throw err;
  } finally {
    if (holdServer) {
      try {
        holdServer.close();
      } catch {}
    }
    for (const inst of activeInstances) {
      if (inst.child.exitCode === null && inst.child.signalCode === null) {
        await stopProcessTree(inst.child, 3000);
      }
    }
    if (canonicalTempDir && fs.existsSync(canonicalTempDir)) {
      try {
        fs.rmSync(canonicalTempDir, { recursive: true, force: true });
      } catch {}
    }
  }
}

const isDirectExecution =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectExecution) {
  runSmokeTest().catch((err) => {
    console.error(`[smoke] Fatal error: ${err.message}`);
    process.exit(1);
  });
}
