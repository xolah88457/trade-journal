import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  validateOrigin,
  isTrustedSender,
  isSafeExternalUrl,
  validatePermissionCheckDetails,
  validatePermissionRequestDetails,
  setupSecurityHandlers,
} from "./security.cjs";

test("validateOrigin enforces exact origin matching and rejects startsWith bypasses", () => {
  const expectedOrigin = "http://127.0.0.1:41234";

  // Exact matches
  assert.equal(validateOrigin("http://127.0.0.1:41234", expectedOrigin), true);
  assert.equal(validateOrigin("http://127.0.0.1:41234/", expectedOrigin), true);
  assert.equal(validateOrigin("http://127.0.0.1:41234/trades?filter=all", expectedOrigin), true);

  // Starts-with spoofing attacks
  assert.equal(validateOrigin("http://127.0.0.1:41234.attacker.com", expectedOrigin), false);
  assert.equal(validateOrigin("http://127.0.0.1:41234@attacker.com", expectedOrigin), false);

  // Port mismatches
  assert.equal(validateOrigin("http://127.0.0.1:41235", expectedOrigin), false);
  assert.equal(validateOrigin("http://127.0.0.1:3000", expectedOrigin), false);

  // Scheme & Host mismatches
  assert.equal(validateOrigin("https://127.0.0.1:41234", expectedOrigin), false);
  assert.equal(validateOrigin("http://localhost:41234", expectedOrigin), false);

  // Malformed URLs
  assert.equal(validateOrigin("not-a-url", expectedOrigin), false);
  assert.equal(validateOrigin(null, expectedOrigin), false);
  assert.equal(validateOrigin("", expectedOrigin), false);
});

test("isTrustedSender verifies webContents identity, mainFrame identity, and exact origin", () => {
  const expectedOrigin = "http://127.0.0.1:41234";

  const mainFrame = {
    url: "http://127.0.0.1:41234/dashboard",
    parent: null,
  };

  const subFrame = {
    url: "http://127.0.0.1:41234/embed",
    parent: mainFrame,
  };

  const webContents = {
    mainFrame,
  };

  const mainWindow = {
    webContents,
  };

  // Valid sender from main frame
  const validEvent = {
    sender: webContents,
    senderFrame: mainFrame,
  };
  assert.equal(isTrustedSender(validEvent, mainWindow, expectedOrigin), true);

  // Subframe / iframe sender rejected
  const subframeEvent = {
    sender: webContents,
    senderFrame: subFrame,
  };
  assert.equal(isTrustedSender(subframeEvent, mainWindow, expectedOrigin), false);

  // Untrusted webContents rejected
  const untrustedWcEvent = {
    sender: { mainFrame },
    senderFrame: mainFrame,
  };
  assert.equal(isTrustedSender(untrustedWcEvent, mainWindow, expectedOrigin), false);

  // Mismatched frame origin rejected
  const evilFrameEvent = {
    sender: webContents,
    senderFrame: {
      url: "http://attacker.com/evil",
      parent: null,
    },
  };
  assert.equal(isTrustedSender(evilFrameEvent, mainWindow, expectedOrigin), false);

  // Missing sender frame rejected
  assert.equal(isTrustedSender({ sender: webContents }, mainWindow, expectedOrigin), false);
});

test("isSafeExternalUrl allows deliberate http/https/mailto without credentials and blocks others", () => {
  // Allowed safe external URLs
  assert.equal(isSafeExternalUrl("https://github.com/LuxAlgo/trade-journal"), true);
  assert.equal(isSafeExternalUrl("http://example.com/docs"), true);
  assert.equal(isSafeExternalUrl("mailto:support@sumi.local"), true);

  // Blocked protocols
  assert.equal(isSafeExternalUrl("file:///etc/passwd"), false);
  assert.equal(isSafeExternalUrl("javascript:alert(1)"), false);
  assert.equal(isSafeExternalUrl("data:text/html,<h1>Hello</h1>"), false);
  assert.equal(isSafeExternalUrl("chrome://settings"), false);

  // Credentials in URL strictly blocked
  assert.equal(isSafeExternalUrl("https://user:pass@example.com"), false);
  assert.equal(isSafeExternalUrl("https://admin:@example.com"), false);
  assert.equal(isSafeExternalUrl("http://user@example.com"), false);
});

test("validatePermissionCheckDetails uses the SINGULAR mediaType of Electron 45 check handler details", () => {
  // Realistic Electron 45.2.3 PermissionCheckHandlerHandlerDetails payloads
  // { isMainFrame, mediaType?: 'video'|'audio'|'unknown', requestingUrl?, securityOrigin?, embeddingOrigin? }

  // Audio-only main-frame check -> granted
  assert.equal(
    validatePermissionCheckDetails({
      isMainFrame: true,
      mediaType: "audio",
      requestingUrl: "http://127.0.0.1:41234/journal",
      securityOrigin: "http://127.0.0.1:41234",
    }),
    true,
  );

  // Camera (video) -> denied
  assert.equal(
    validatePermissionCheckDetails({
      isMainFrame: true,
      mediaType: "video",
      requestingUrl: "http://127.0.0.1:41234/journal",
      securityOrigin: "http://127.0.0.1:41234",
    }),
    false,
  );

  // unknown -> denied
  assert.equal(
    validatePermissionCheckDetails({
      isMainFrame: true,
      mediaType: "unknown",
      securityOrigin: "http://127.0.0.1:41234",
    }),
    false,
  );

  // Missing mediaType entirely -> denied (never default-allow)
  assert.equal(
    validatePermissionCheckDetails({
      isMainFrame: true,
      securityOrigin: "http://127.0.0.1:41234",
    }),
    false,
  );

  // Subframe/iframe check -> denied even for audio
  assert.equal(
    validatePermissionCheckDetails({
      isMainFrame: false,
      mediaType: "audio",
      securityOrigin: "http://127.0.0.1:41234",
      embeddingOrigin: "https://evil.com",
    }),
    false,
  );

  // Null / malformed details -> denied
  assert.equal(validatePermissionCheckDetails(null), false);
  assert.equal(validatePermissionCheckDetails({ isMainFrame: true, mediaTypes: ["audio"] }), false);
});

test("validatePermissionRequestDetails uses the mediaTypes ARRAY of Electron 45 request handler details", () => {
  // Realistic MediaAccessPermissionRequest payloads:
  // { isMainFrame, requestingUrl, mediaTypes?: ['video'|'audio'], securityOrigin? }

  // Exactly ['audio'] on main frame -> granted
  assert.equal(
    validatePermissionRequestDetails({
      isMainFrame: true,
      requestingUrl: "http://127.0.0.1:41234/journal",
      mediaTypes: ["audio"],
      securityOrigin: "http://127.0.0.1:41234",
    }),
    true,
  );

  // audio + video (camera+mic) -> denied
  assert.equal(
    validatePermissionRequestDetails({
      isMainFrame: true,
      requestingUrl: "http://127.0.0.1:41234/journal",
      mediaTypes: ["audio", "video"],
    }),
    false,
  );

  // video only (camera) -> denied
  assert.equal(
    validatePermissionRequestDetails({
      isMainFrame: true,
      requestingUrl: "http://127.0.0.1:41234/journal",
      mediaTypes: ["video"],
    }),
    false,
  );

  // Empty array / missing array -> denied
  assert.equal(
    validatePermissionRequestDetails({
      isMainFrame: true,
      requestingUrl: "http://127.0.0.1:41234/journal",
      mediaTypes: [],
    }),
    false,
  );
  assert.equal(
    validatePermissionRequestDetails({
      isMainFrame: true,
      requestingUrl: "http://127.0.0.1:41234/journal",
    }),
    false,
  );

  // Subframe requesting audio -> denied
  assert.equal(
    validatePermissionRequestDetails({
      isMainFrame: false,
      requestingUrl: "http://127.0.0.1:41234/embed",
      mediaTypes: ["audio"],
    }),
    false,
  );

  // Null / malformed -> denied
  assert.equal(validatePermissionRequestDetails(null), false);
  assert.equal(validatePermissionRequestDetails({ isMainFrame: true, mediaType: "audio" }), false);
});

test("setupSecurityHandlers wires navigation, webviews, and active download cancellations", () => {
  const eventListeners = new Map();
  let windowOpenHandler = null;
  let webviewPrevented = false;
  let permissionRequestHandler = null;
  let permissionCheckHandler = null;

  const mockWebContents = {
    on(event, handler) {
      eventListeners.set(event, handler);
    },
    setWindowOpenHandler(handler) {
      windowOpenHandler = handler;
    },
  };

  const cancelCalls = [];
  const mockItem = {
    getURL: () => "http://127.0.0.1:4000/report.pdf",
    getFilename: () => "report.pdf",
    cancel: () => cancelCalls.push("cancel"),
    once: () => {},
    setSavePath: () => {},
  };

  const mockSession = {
    on(event, handler) {
      if (event === "will-download") {
        handler({}, mockItem);
      }
    },
    setPermissionRequestHandler(handler) {
      permissionRequestHandler = handler;
    },
    setPermissionCheckHandler(handler) {
      permissionCheckHandler = handler;
    },
  };

  const mockShell = {
    opened: [],
    openExternal(url) {
      this.opened.push(url);
    },
  };

  const security = setupSecurityHandlers({
    mainWindow: { webContents: mockWebContents },
    expectedOrigin: "http://127.0.0.1:4000",
    shell: mockShell,
    session: mockSession,
    isTestMode: false,
    dialog: {
      showSaveDialogSync: () => "/path/to/report.pdf",
    },
  });

  // Verify webview is blocked
  const attachWebview = eventListeners.get("will-attach-webview");
  assert.ok(attachWebview);
  attachWebview({
    preventDefault: () => {
      webviewPrevented = true;
    },
  });
  assert.equal(webviewPrevented, true);

  // Popup handler ALWAYS denies OS-opening popups - with any actual HandlerDetails
  // payload { url, frameName, features, disposition, referrer, postBody }.
  // Legit links, missing referrer, and iframe launches are all denied here;
  // deliberate external opens go through the restricted preload IPC instead.
  assert.ok(windowOpenHandler);
  const realDetails = {
    url: "https://github.com/LuxAlgo/trade-journal",
    frameName: "_blank",
    features: "",
    disposition: "foreground-tab",
    referrer: { url: "http://127.0.0.1:4000/", policy: "strict-origin-when-cross-origin" },
    postBody: null,
  };
  assert.deepEqual(windowOpenHandler(realDetails), { action: "deny" });
  assert.deepEqual(
    windowOpenHandler({
      ...realDetails,
      url: "https://evil.com/",
      referrer: { url: "", policy: "no-referrer" },
    }),
    { action: "deny" },
  );
  assert.deepEqual(windowOpenHandler({ ...realDetails, referrer: undefined }), { action: "deny" });
  assert.deepEqual(mockShell.opened, []); // No shell.openExternal EVER in popup handler

  // Verify will-navigate: external main-frame nav PREVENTED without OS launch
  const willNavigate = eventListeners.get("will-navigate");
  assert.ok(willNavigate);
  mockShell.opened = [];
  let mainFrameNavPrevented = false;
  willNavigate(
    {
      isMainFrame: true,
      preventDefault: () => {
        mainFrameNavPrevented = true;
      },
    },
    "https://github.com/LuxAlgo/trade-journal",
  );
  assert.equal(mainFrameNavPrevented, true);
  assert.deepEqual(mockShell.opened, []); // NO OS launch from will-navigate

  // Local same-origin main-frame navigation allowed
  let localPrevented = false;
  willNavigate(
    {
      isMainFrame: true,
      preventDefault: () => {
        localPrevented = true;
      },
    },
    "http://127.0.0.1:4000/settings",
  );
  assert.equal(localPrevented, false);
  // about:blank allowed
  willNavigate(
    {
      isMainFrame: true,
      preventDefault: () => {
        localPrevented = true;
      },
    },
    "about:blank",
  );
  assert.equal(localPrevented, false);

  // Verify subframes cannot launch OS browser via will-navigate
  mockShell.opened = [];
  let subframePrevented = false;
  willNavigate(
    {
      isMainFrame: false,
      preventDefault: () => {
        subframePrevented = true;
      },
    },
    "https://evil.com/subframe",
  );
  assert.equal(subframePrevented, true);
  assert.deepEqual(mockShell.opened, []);

  // Verify blob: URL navigation validates embedded origin via URL(blob).origin
  let blobNavPrevented = false;
  willNavigate(
    {
      isMainFrame: true,
      preventDefault: () => {
        blobNavPrevented = true;
      },
    },
    "blob:http://127.0.0.1:4000/abc-def",
  );
  assert.equal(blobNavPrevented, false); // Same-origin blob allowed

  blobNavPrevented = false;
  willNavigate(
    {
      isMainFrame: true,
      preventDefault: () => {
        blobNavPrevented = true;
      },
    },
    "blob:https://evil.com/abc-def",
  );
  assert.equal(blobNavPrevented, true); // Cross-origin blob denied

  // Verify active downloads cancellation (PDF download flow retained)
  assert.equal(security.getActiveDownloadsCount(), 1);
  security.cancelActiveDownloads();
  assert.equal(cancelCalls.length, 1);
  assert.equal(security.getActiveDownloadsCount(), 0);

  // --- Permission handlers: realistic Electron 45 payloads ---
  assert.ok(permissionRequestHandler);
  assert.ok(permissionCheckHandler);

  const granted = [];
  const requestCb = (ok) => granted.push(ok);

  // REQUEST handler: trusted wc + main frame + exact origin + mediaTypes ['audio'] -> grant
  permissionRequestHandler(mockWebContents, "media", requestCb, {
    isMainFrame: true,
    requestingUrl: "http://127.0.0.1:4000/journal",
    mediaTypes: ["audio"],
    securityOrigin: "http://127.0.0.1:4000",
  });
  assert.deepEqual(granted, [true]);

  // REQUEST: camera (video in mediaTypes) -> deny
  permissionRequestHandler(mockWebContents, "media", requestCb, {
    isMainFrame: true,
    requestingUrl: "http://127.0.0.1:4000/journal",
    mediaTypes: ["video"],
  });
  // REQUEST: iframe -> deny
  permissionRequestHandler(mockWebContents, "media", requestCb, {
    isMainFrame: false,
    requestingUrl: "http://127.0.0.1:4000/embed",
    mediaTypes: ["audio"],
  });
  // REQUEST: wrong origin -> deny
  permissionRequestHandler(mockWebContents, "media", requestCb, {
    isMainFrame: true,
    requestingUrl: "https://evil.com/",
    mediaTypes: ["audio"],
  });
  // REQUEST: untrusted webContents -> deny
  permissionRequestHandler({ other: true }, "media", requestCb, {
    isMainFrame: true,
    requestingUrl: "http://127.0.0.1:4000/journal",
    mediaTypes: ["audio"],
  });
  assert.deepEqual(granted, [true, false, false, false, false]);

  // CHECK handler (singular mediaType): trusted wc + exact requestingOrigin + audio -> true
  assert.equal(
    permissionCheckHandler(mockWebContents, "media", "http://127.0.0.1:4000", {
      isMainFrame: true,
      mediaType: "audio",
      requestingUrl: "http://127.0.0.1:4000/journal",
      securityOrigin: "http://127.0.0.1:4000",
    }),
    true,
  );
  // CHECK: camera -> false
  assert.equal(
    permissionCheckHandler(mockWebContents, "media", "http://127.0.0.1:4000", {
      isMainFrame: true,
      mediaType: "video",
      securityOrigin: "http://127.0.0.1:4000",
    }),
    false,
  );
  // CHECK: unknown -> false
  assert.equal(
    permissionCheckHandler(mockWebContents, "microphone", "http://127.0.0.1:4000", {
      isMainFrame: true,
      mediaType: "unknown",
    }),
    false,
  );
  // CHECK: iframe -> false
  assert.equal(
    permissionCheckHandler(mockWebContents, "media", "http://127.0.0.1:4000", {
      isMainFrame: false,
      mediaType: "audio",
      embeddingOrigin: "https://evil.com",
    }),
    false,
  );
  // CHECK: wrong origin -> false
  assert.equal(
    permissionCheckHandler(mockWebContents, "media", "https://evil.com", {
      isMainFrame: true,
      mediaType: "audio",
    }),
    false,
  );
  // CHECK: untrusted wc -> false
  assert.equal(
    permissionCheckHandler({ other: true }, "media", "http://127.0.0.1:4000", {
      isMainFrame: true,
      mediaType: "audio",
    }),
    false,
  );
});

test("setupSecurityHandlers will-download validates blob origin and cancels untrusted downloads", () => {
  const downloads = [];
  const mockWebContents = {
    on() {},
    setWindowOpenHandler() {},
  };
  const makeItem = (url) => ({
    getURL: () => url,
    getFilename: () => "file.bin",
    cancel: () => downloads.push(`cancel:${url}`),
    once: () => {},
    setSavePath: (p) => downloads.push(`save:${url}->${p}`),
  });
  let downloadHandler = null;
  const mockSession = {
    on(event, handler) {
      if (event === "will-download") downloadHandler = handler;
    },
    setPermissionRequestHandler() {},
    setPermissionCheckHandler() {},
  };

  const expectedPath = path.join("/tmp/sumi-dl-test", "file.bin");

  setupSecurityHandlers({
    mainWindow: { webContents: mockWebContents },
    expectedOrigin: "http://127.0.0.1:4000",
    session: mockSession,
    isTestMode: true,
    downloadDir: "/tmp/sumi-dl-test",
    dialog: { showSaveDialogSync: () => expectedPath },
  });
  assert.ok(downloadHandler);

  // Same-origin blob download allowed (validated via URL(blob).origin)
  downloadHandler({}, makeItem("blob:http://127.0.0.1:4000/abc"));
  // Cross-origin blob download cancelled
  downloadHandler({}, makeItem("blob:https://evil.com/abc"));
  // Same-origin http download allowed
  downloadHandler({}, makeItem("http://127.0.0.1:4000/api/attachments/1"));
  // External download cancelled
  downloadHandler({}, makeItem("https://evil.com/malware.zip"));

  assert.deepEqual(downloads, [
    `save:blob:http://127.0.0.1:4000/abc->${expectedPath}`,
    "cancel:blob:https://evil.com/abc",
    `save:http://127.0.0.1:4000/api/attachments/1->${expectedPath}`,
    "cancel:https://evil.com/malware.zip",
  ]);
});
