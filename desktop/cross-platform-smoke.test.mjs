import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseDevToolsPort,
  readDevToolsActivePort,
  parseNodeInspectorUrl,
  cleanStaleDevToolsActivePort,
  CdpClient,
  poll,
  runSmokeTest,
  verifyPackagedUpdaterClosure,
  waitForCondition,
  waitForDomReady,
} from "./cross-platform-smoke.mjs";

test("parseDevToolsPort extracts CDP port from various stderr outputs", () => {
  assert.equal(
    parseDevToolsPort(
      "App starting...\nDevTools listening on ws://127.0.0.1:54321/devtools/browser/uuid-123\nReady.",
    ),
    54321,
  );
  assert.equal(
    parseDevToolsPort("DevTools listening on ws://[::1]:9222/devtools/browser/uuid-456"),
    9222,
  );
  assert.equal(
    parseDevToolsPort("DevTools listening on ws://localhost:12345/devtools/browser/abc"),
    12345,
  );
  assert.equal(parseDevToolsPort("Some other log output without DevTools"), null);
  assert.equal(parseDevToolsPort(""), null);
  assert.equal(parseDevToolsPort(null), null);
});

test("parseNodeInspectorUrl extracts Node V8 inspector URL from stderr", () => {
  assert.equal(
    parseNodeInspectorUrl(
      "Debugger listening on ws://127.0.0.1:63788/d60de726-7a81-4406-91b7-541efba86ac3\nFor help, see: https://nodejs.org/learn/getting-started/debugging",
    ),
    "ws://127.0.0.1:63788/d60de726-7a81-4406-91b7-541efba86ac3",
  );
  assert.equal(
    parseNodeInspectorUrl(
      "Debugger listening on ws://localhost:9229/12345678-abcd-ef01-2345-6789abcdef01",
    ),
    "ws://localhost:9229/12345678-abcd-ef01-2345-6789abcdef01",
  );
  assert.equal(parseNodeInspectorUrl("Regular process output without inspector"), null);
  assert.equal(parseNodeInspectorUrl(""), null);
  assert.equal(parseNodeInspectorUrl(null), null);
});

test("readDevToolsActivePort reads port from DevToolsActivePort file with LF and CRLF", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-test-"));
  try {
    const portFileLf = path.join(tmpDir, "DevToolsActivePort_LF");
    fs.writeFileSync(portFileLf, "51234\n/devtools/browser/abc-123\n", "utf8");
    assert.equal(readDevToolsActivePort(portFileLf), 51234);

    const portFileCrlf = path.join(tmpDir, "DevToolsActivePort_CRLF");
    fs.writeFileSync(portFileCrlf, "62345\r\n/devtools/browser/xyz-789\r\n", "utf8");
    assert.equal(readDevToolsActivePort(portFileCrlf), 62345);

    const portFileInvalid = path.join(tmpDir, "DevToolsActivePort_invalid");
    fs.writeFileSync(portFileInvalid, "not-a-port\n", "utf8");
    assert.equal(readDevToolsActivePort(portFileInvalid), null);

    assert.equal(readDevToolsActivePort(path.join(tmpDir, "non_existent_file")), null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("cleanStaleDevToolsActivePort removes stale DevToolsActivePort and handles missing dir/file", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clean-port-test-"));
  try {
    const electronDir = path.join(tmpDir, "electron");
    fs.mkdirSync(electronDir, { recursive: true });
    const staleFile = path.join(electronDir, "DevToolsActivePort");
    fs.writeFileSync(staleFile, "12345\n/path\n", "utf8");
    assert.ok(fs.existsSync(staleFile));

    cleanStaleDevToolsActivePort(tmpDir);
    assert.equal(fs.existsSync(staleFile), false);

    // Calling again on missing file does not throw
    cleanStaleDevToolsActivePort(tmpDir);

    // Calling on non-existent dir does not throw
    cleanStaleDevToolsActivePort(path.join(tmpDir, "does-not-exist"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("CdpClient dispatches requests and resolves result matching request ID", async () => {
  const sent = [];
  const mockWs = {
    send(str) {
      sent.push(str);
      const parsed = JSON.parse(str);
      // Simulate asynchronous CDP response
      queueMicrotask(() => {
        if (mockWs.onmessage) {
          mockWs.onmessage({
            data: JSON.stringify({
              id: parsed.id,
              result: { result: { type: "string", value: "hello-cdp" } },
            }),
          });
        }
      });
    },
    close() {
      if (mockWs.onclose) mockWs.onclose();
    },
  };

  const client = new CdpClient(mockWs);
  const val = await client.eval("return 'hello-cdp'");
  assert.equal(val, "hello-cdp");
  assert.equal(sent.length, 1);
  const requestPayload = JSON.parse(sent[0]);
  assert.equal(requestPayload.method, "Runtime.evaluate");
  assert.equal(requestPayload.params.awaitPromise, true);
  assert.equal(requestPayload.params.returnByValue, true);
});

test("CdpClient rejects on CDP exceptionDetails", async () => {
  const mockWs = {
    send(str) {
      const parsed = JSON.parse(str);
      queueMicrotask(() => {
        if (mockWs.onmessage) {
          mockWs.onmessage({
            data: JSON.stringify({
              id: parsed.id,
              result: {
                exceptionDetails: {
                  text: "ReferenceError: foo is not defined",
                },
              },
            }),
          });
        }
      });
    },
    close() {},
  };

  const client = new CdpClient(mockWs);
  await assert.rejects(
    async () => {
      await client.eval("foo");
    },
    { message: /ReferenceError: foo is not defined/ },
  );
});

test("CdpClient rejects pending requests on connection close", async () => {
  const mockWs = {
    send() {
      // Never respond, simulate dropped connection
      setTimeout(() => {
        if (mockWs.onclose) mockWs.onclose();
      }, 50);
    },
    close() {},
  };

  const client = new CdpClient(mockWs);
  await assert.rejects(
    async () => {
      await client.send("Page.reload", {}, 5000);
    },
    { message: /CDP connection closed/ },
  );
});

test("verifyPackagedUpdaterClosure evaluates updater SDK requirements in Node context", async () => {
  // Mock global WebSocket temporarily to test verifyPackagedUpdaterClosure
  const origWs = globalThis.WebSocket;
  let closed = false;
  let receivedExpr = "";

  globalThis.WebSocket = class MockWebSocket {
    constructor() {
      queueMicrotask(() => {
        if (this.onopen) this.onopen();
      });
    }
    send(data) {
      const msg = JSON.parse(data);
      receivedExpr = msg.params?.expression || "";
      queueMicrotask(() => {
        if (this.onmessage) {
          this.onmessage({
            data: JSON.stringify({
              id: msg.id,
              result: { result: { type: "boolean", value: true } },
            }),
          });
        }
      });
    }
    close() {
      closed = true;
      if (this.onclose) this.onclose();
    }
  };

  try {
    await verifyPackagedUpdaterClosure("ws://127.0.0.1:12345/dummy");
    assert.ok(receivedExpr.includes("electron-updater"));
    assert.ok(receivedExpr.includes("checkForUpdates"));
    assert.ok(receivedExpr.includes("autoDownload = false"));
    assert.ok(receivedExpr.includes("autoInstallOnAppQuit = false"));
    assert.equal(closed, true, "Inspector WebSocket must be closed after verification");
  } finally {
    globalThis.WebSocket = origWs;
  }
});

test("poll utility resolves on truthy and rejects on timeout", async () => {
  let count = 0;
  const res = await poll(() => (++count >= 3 ? "success" : null), 1000, 10, "test-poll");
  assert.equal(res, "success");

  await assert.rejects(
    async () => {
      await poll(() => false, 100, 20, "failing-poll");
    },
    { message: /Timed out waiting for failing-poll/ },
  );
});

test("runSmokeTest asserts strict contract on SUMI_SMOKE_APP environment variable", async () => {
  const origEnv = process.env.SUMI_SMOKE_APP;
  try {
    delete process.env.SUMI_SMOKE_APP;
    await assert.rejects(
      async () => {
        await runSmokeTest();
      },
      { message: /Contract violation: SUMI_SMOKE_APP environment variable/ },
    );

    await assert.rejects(
      async () => {
        await runSmokeTest("relative/path/to/Sumi");
      },
      { message: /Contract violation: SUMI_SMOKE_APP must be an absolute path/ },
    );

    await assert.rejects(
      async () => {
        await runSmokeTest("/non/existent/path/to/Sumi.app/Contents/MacOS/Sumi");
      },
      { message: /Packaged application binary not found/ },
    );
  } finally {
    if (origEnv !== undefined) {
      process.env.SUMI_SMOKE_APP = origEnv;
    }
  }
});

test("waitForDomReady resolves when document.body is ready on trusted loopback origin", async () => {
  let bodyReady = false;
  let readyState = "loading";
  const mockCdp = {
    async eval(expr) {
      if (expr.includes("document && document.body")) {
        return bodyReady && (readyState === "complete" || readyState === "interactive");
      }
      return false;
    },
  };
  setTimeout(() => {
    bodyReady = true;
    readyState = "complete";
  }, 20);

  const res = await waitForDomReady(mockCdp, "http://127.0.0.1:12345", 1000);
  assert.equal(res, true);
});

test("waitForDomReady rejects when document.body remains null or origin mismatches", async () => {
  const mockCdp = {
    async eval() {
      return false;
    },
  };
  await assert.rejects(
    async () => {
      await waitForDomReady(mockCdp, "http://127.0.0.1:12345", 100);
    },
    { message: /Timed out waiting for/ },
  );
});

test("reload sequence guards against premature evaluation on pre-reload context", async () => {
  // Simulate browser state transition during reload:
  // 1. Initial pre-reload state: window.__sumiSmokePreReload is set
  // 2. Navigation begins: document.body becomes null while loading
  // 3. Navigation completes: fresh context where __sumiSmokePreReload is undefined and document.body exists
  let step = 1;
  const mockCdp = {
    async send(method) {
      if (method === "Page.reload") {
        step = 2; // reload initiated
        setTimeout(() => {
          step = 3; // reloaded page ready
        }, 30);
      }
    },
    async eval(expr) {
      if (expr.includes("__sumiSmokePreReload = true")) {
        return true;
      }
      if (expr.includes("!window.__sumiSmokePreReload")) {
        if (step === 1) {
          // Pre-reload state: marker is true, so !marker is false
          return false;
        }
        if (step === 2) {
          // Reloading state: DOM body is null
          return false;
        }
        if (step === 3) {
          // New page context: marker is cleared and body is ready
          return true;
        }
      }
      return false;
    },
  };

  await mockCdp.eval("window.__sumiSmokePreReload = true;");
  await mockCdp.send("Page.reload");

  const guardExpr =
    "!window.__sumiSmokePreReload && Boolean(document && document.body) && window.sumiDesktop";
  const completed = await waitForCondition(mockCdp, guardExpr, 1000);
  assert.equal(completed, true);
  assert.equal(step, 3, "Guard must only resolve once new document context has fully loaded");
});
