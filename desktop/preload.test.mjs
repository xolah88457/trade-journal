import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const preloadCode = fs.readFileSync(path.join(__dirname, "preload.cjs"), "utf8");

test("preload exposes narrow sumiDesktop API on main frame and reads sync preferences", () => {
  let exposedName = null;
  let exposedApi = null;
  const ipcSent = [];
  const ipcInvoked = [];

  const mockContextBridge = {
    exposeInMainWorld(name, api) {
      exposedName = name;
      exposedApi = api;
    },
  };

  const mockIpcRenderer = {
    sendSync(channel) {
      if (channel === "sumi:get-preferences-sync") {
        return { "journal-theme-v1": "dark" };
      }
      return {};
    },
    send(channel, ...args) {
      ipcSent.push({ channel, args });
    },
    invoke(channel, ...args) {
      ipcInvoked.push({ channel, args });
      return Promise.resolve({ success: true, channel });
    },
  };

  const mockWebFrame = {
    top: null, // main frame
  };

  const clickListeners = [];
  const assignedUrls = [];
  const mockDocument = {
    addEventListener(type, handler, capture) {
      clickListeners.push({ type, handler, capture });
    },
  };
  const mockWindow = {
    location: {
      href: "http://127.0.0.1:45678/journal",
      origin: "http://127.0.0.1:45678",
      assign(url) {
        assignedUrls.push(url);
      },
    },
  };

  const sandbox = {
    require: (mod) => {
      if (mod === "electron") {
        return {
          contextBridge: mockContextBridge,
          ipcRenderer: mockIpcRenderer,
          webFrame: mockWebFrame,
        };
      }
      throw new Error(`Unexpected require: ${mod}`);
    },
    process: {
      isMainFrame: true,
    },
    document: mockDocument,
    window: mockWindow,
    URL,
    console,
  };

  runInNewContext(preloadCode, sandbox);

  assert.equal(exposedName, "sumiDesktop");
  assert.ok(exposedApi);

  // Exact shape of exposed API
  const keys = Object.keys(exposedApi).sort();
  assert.deepEqual(keys, ["checkForUpdates", "getInfo", "preferences", "savePreferences"]);

  // Initial preferences retrieved via sync IPC
  assert.deepEqual({ ...exposedApi.preferences }, { "journal-theme-v1": "dark" });
  assert.ok(Object.isFrozen(exposedApi.preferences));

  // savePreferences dispatches fixed IPC channel
  exposedApi.savePreferences({ "journal-theme-v1": "light" });
  assert.deepEqual(ipcSent, [
    {
      channel: "sumi:save-preferences",
      args: [{ "journal-theme-v1": "light" }],
    },
  ]);

  // invoke actions map fixed names
  exposedApi.getInfo();
  exposedApi.checkForUpdates();

  assert.deepEqual(
    ipcInvoked.map((i) => i.channel),
    ["sumi:get-info", "sumi:check-for-updates"],
  );

  // Ensure no dangerous APIs leaked
  assert.equal(exposedApi.ipcRenderer, undefined);
  assert.equal(exposedApi.shell, undefined);
  assert.equal(exposedApi.fs, undefined);
});

test("preload does not expose sumiDesktop in subframes or iframes", () => {
  let exposedName = null;

  const sandbox = {
    require: (mod) => {
      if (mod === "electron") {
        return {
          contextBridge: {
            exposeInMainWorld(name) {
              exposedName = name;
            },
          },
          ipcRenderer: { sendSync: () => ({}) },
          webFrame: { top: {} }, // subframe!
        };
      }
      throw new Error(`Unexpected require: ${mod}`);
    },
    process: {
      isMainFrame: false, // subframe
    },
    console,
  };

  runInNewContext(preloadCode, sandbox);
  assert.equal(exposedName, null);
});

function runPreloadMainFrame() {
  const ipcSent = [];
  const clickListeners = [];
  const assignedUrls = [];
  const sandbox = {
    require: (mod) => {
      if (mod === "electron") {
        return {
          contextBridge: { exposeInMainWorld() {} },
          ipcRenderer: {
            sendSync: () => ({}),
            send(channel, ...args) {
              ipcSent.push({ channel, args });
            },
            invoke: () => Promise.resolve({}),
          },
          webFrame: { top: null },
        };
      }
      throw new Error(`Unexpected require: ${mod}`);
    },
    process: { isMainFrame: true },
    document: {
      addEventListener(type, handler, capture) {
        clickListeners.push({ type, handler, capture });
      },
    },
    window: {
      location: {
        href: "http://127.0.0.1:45678/journal",
        origin: "http://127.0.0.1:45678",
        assign(url) {
          assignedUrls.push(url);
        },
      },
    },
    URL,
    console,
  };
  runInNewContext(preloadCode, sandbox);
  const click = clickListeners.find((l) => l.type === "click");
  assert.ok(click, "preload must register a click listener in the main frame");
  assert.equal(click.capture, true);
  return { clickHandler: click.handler, ipcSent, assignedUrls };
}

function makeAnchorEvent({ href, target = "_blank", isTrusted = true, button = 0 }) {
  let prevented = false;
  const anchor = {
    getAttribute: (name) => (name === "href" ? href : name === "target" ? target : null),
  };
  return {
    event: {
      isTrusted,
      button,
      defaultPrevented: false,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      target: { closest: (sel) => (sel === "a[href]" ? anchor : null) },
      preventDefault: () => {
        prevented = true;
      },
    },
    wasPrevented: () => prevented,
  };
}

test("preload brokers trusted external target=_blank anchor clicks via restricted IPC only", () => {
  const { clickHandler, ipcSent, assignedUrls } = runPreloadMainFrame();

  // Real user click on external GitHub link -> preventDefault + sumi:open-external
  const ext = makeAnchorEvent({ href: "https://github.com/LuxAlgo/trade-journal" });
  clickHandler(ext.event);
  assert.equal(ext.wasPrevented(), true);
  assert.deepEqual(ipcSent, [
    { channel: "sumi:open-external", args: ["https://github.com/LuxAlgo/trade-journal"] },
  ]);
  assert.deepEqual(assignedUrls, []);

  // mailto: link -> same restricted channel
  const mail = makeAnchorEvent({ href: "mailto:support@sumi.local" });
  clickHandler(mail.event);
  assert.equal(mail.wasPrevented(), true);
  assert.deepEqual(ipcSent[1], {
    channel: "sumi:open-external",
    args: ["mailto:support@sumi.local"],
  });

  // External URL with embedded credentials -> NOT sent
  const creds = makeAnchorEvent({ href: "https://user:pass@evil.com/" });
  clickHandler(creds.event);
  assert.equal(ipcSent.length, 2);

  // Synthetic (isTrusted=false) click -> ignored entirely, falls through to always-deny popup
  const synthetic = makeAnchorEvent({ href: "https://evil.com/", isTrusted: false });
  clickHandler(synthetic.event);
  assert.equal(synthetic.wasPrevented(), false);
  assert.equal(ipcSent.length, 2);

  // Non-left click -> ignored
  const rightClick = makeAnchorEvent({ href: "https://example.com/", button: 2 });
  clickHandler(rightClick.event);
  assert.equal(ipcSent.length, 2);
});

test("preload routes trusted same-origin target=_blank anchors to local navigation", () => {
  const { clickHandler, ipcSent, assignedUrls } = runPreloadMainFrame();

  // Internal /settings link with target=_blank (import-reconciliation) -> local nav
  const internal = makeAnchorEvent({ href: "/settings" });
  clickHandler(internal.event);
  assert.equal(internal.wasPrevented(), true);
  assert.deepEqual(assignedUrls, ["http://127.0.0.1:45678/settings"]);
  assert.deepEqual(ipcSent, []); // no IPC for local navigation

  // Same-origin blob: URL -> local nav (origin matches)
  const blob = makeAnchorEvent({ href: "blob:http://127.0.0.1:45678/abc-123" });
  clickHandler(blob.event);
  assert.equal(blob.wasPrevented(), true);
  assert.deepEqual(assignedUrls[1], "blob:http://127.0.0.1:45678/abc-123");
  assert.deepEqual(ipcSent, []);

  // Cross-origin blob: -> not navigated locally, not sent via IPC (popup handler denies)
  const evilBlob = makeAnchorEvent({ href: "blob:https://evil.com/abc" });
  clickHandler(evilBlob.event);
  assert.equal(evilBlob.wasPrevented(), false);
  assert.deepEqual(ipcSent, []);

  // Plain LOCAL anchor without target -> fully native (will-navigate allows same-origin)
  const plainLocal = makeAnchorEvent({ href: "/trades/123", target: null });
  clickHandler(plainLocal.event);
  assert.equal(plainLocal.wasPrevented(), false);
  assert.deepEqual(ipcSent, []);
  assert.deepEqual(assignedUrls, [
    "http://127.0.0.1:45678/settings",
    "blob:http://127.0.0.1:45678/abc-123",
  ]);

  // javascript: / file: hrefs -> never sent via IPC
  const js = makeAnchorEvent({ href: "javascript:alert(1)" });
  clickHandler(js.event);
  assert.deepEqual(ipcSent, []);
});

test("preload brokers trusted PLAIN external anchors (no target / _self) via restricted IPC", () => {
  // Regression: rich-editor renders ordinary external <a href> with NO target;
  // will-navigate prevents external in-shell nav, so these must go via IPC.
  const { clickHandler, ipcSent, assignedUrls } = runPreloadMainFrame();

  // No target at all (rich-editor case)
  const plain = makeAnchorEvent({ href: "https://example.com/review", target: null });
  clickHandler(plain.event);
  assert.equal(plain.wasPrevented(), true);
  assert.deepEqual(ipcSent, [
    { channel: "sumi:open-external", args: ["https://example.com/review"] },
  ]);
  assert.deepEqual(assignedUrls, []);

  // Explicit _self
  const selfTarget = makeAnchorEvent({
    href: "https://github.com/xolah88457/trade-journal",
    target: "_self",
  });
  clickHandler(selfTarget.event);
  assert.equal(selfTarget.wasPrevented(), true);
  assert.deepEqual(ipcSent[1], {
    channel: "sumi:open-external",
    args: ["https://github.com/xolah88457/trade-journal"],
  });

  // Modified (ctrl/cmd) left click on external anchor is still a real trusted
  // user click -> same restricted channel (minimal, main re-validates)
  const modified = makeAnchorEvent({ href: "https://example.com/docs" });
  modified.event.ctrlKey = true;
  clickHandler(modified.event);
  assert.equal(modified.wasPrevented(), true);
  assert.deepEqual(ipcSent[2], {
    channel: "sumi:open-external",
    args: ["https://example.com/docs"],
  });

  // Untrusted (synthetic) plain external click -> denied, no IPC, no preventDefault
  const synthetic = makeAnchorEvent({ href: "https://evil.com/", target: null, isTrusted: false });
  clickHandler(synthetic.event);
  assert.equal(synthetic.wasPrevented(), false);
  assert.equal(ipcSent.length, 3);

  // Credential-bearing external URL -> denied even when trusted
  const creds = makeAnchorEvent({ href: "https://user:pass@evil.com/", target: null });
  clickHandler(creds.event);
  assert.equal(creds.wasPrevented(), false);
  assert.equal(ipcSent.length, 3);
});
