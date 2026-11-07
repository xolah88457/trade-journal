"use strict";

const path = require("node:path");

/**
 * Validates that candidateUrl has the exact same origin as expectedOrigin.
 *
 * CRITICAL SECURITY RULE:
 * Never use startsWith for origin validation.
 * Uses exact URL.origin comparison to avoid prefix/subdomain spoofing attacks.
 */
function validateOrigin(candidateUrl, expectedOrigin) {
  if (!candidateUrl || !expectedOrigin) return false;
  try {
    const parsed = new URL(candidateUrl);
    return parsed.origin === expectedOrigin;
  } catch {
    return false;
  }
}

/**
 * Validates that an IPC event was dispatched by the trusted main window,
 * strictly from the main frame, matching the expected server origin.
 *
 * Rejects:
 * - Subframes / iframes
 * - Untrusted webContents
 * - Non-matching origins
 */
function isTrustedSender(event, mainWindow, expectedOrigin) {
  if (!mainWindow || !expectedOrigin || !event) return false;
  if (!mainWindow.webContents || event.sender !== mainWindow.webContents) return false;

  const frame = event.senderFrame;
  if (!frame) return false;

  // Must be the main frame (no parent frame)
  if (mainWindow.webContents.mainFrame && frame !== mainWindow.webContents.mainFrame) {
    return false;
  }
  if (frame.parent !== null && frame.parent !== undefined) {
    return false;
  }

  // Exact origin check on the frame URL
  return validateOrigin(frame.url, expectedOrigin);
}

/**
 * Validates external URLs for deliberate user navigation.
 *
 * Requirements:
 * - Only http:, https:, and mailto: protocols allowed.
 * - Credentials (username or password) in URL strictly forbidden to prevent auth spoofing.
 */
function isSafeExternalUrl(candidateUrl) {
  if (!candidateUrl || typeof candidateUrl !== "string") return false;
  try {
    const parsed = new URL(candidateUrl);
    if (
      parsed.protocol !== "https:" &&
      parsed.protocol !== "http:" &&
      parsed.protocol !== "mailto:"
    ) {
      return false;
    }
    // Reject URLs with embedded credentials
    if (parsed.username || parsed.password) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates Electron 45 setPermissionCheckHandler details.
 *
 * Actual PermissionCheckHandlerHandlerDetails (verified against Electron 45.2.3):
 *   { isMainFrame, mediaType?: 'audio'|'video'|'unknown', requestingUrl?, securityOrigin?, embeddingOrigin? }
 * - mediaType is SINGULAR here. Requiring a mediaTypes array in the check callback
 *   would ALWAYS deny the microphone.
 * - Audio-only for the main frame is allowed; camera ('video'), 'unknown' and
 *   iframe/subframe checks are strictly denied.
 */
function validatePermissionCheckDetails(details) {
  if (!details || typeof details !== "object") return false;
  if (!details.isMainFrame) return false;
  return details.mediaType === "audio";
}

/**
 * Validates Electron 45 setPermissionRequestHandler media details.
 *
 * Actual details are PermissionRequest + MediaAccessPermissionRequest:
 *   { isMainFrame, requestingUrl, mediaTypes?: Array<'video'|'audio'>, securityOrigin? }
 * - mediaTypes is an ARRAY here; it must be exactly ['audio'].
 * - Any 'video' (camera) or missing/ambiguous array denies.
 */
function validatePermissionRequestDetails(details) {
  if (!details || typeof details !== "object") return false;
  if (!details.isMainFrame) return false;
  const mediaTypes = details.mediaTypes;
  if (!Array.isArray(mediaTypes) || mediaTypes.length !== 1) return false;
  return mediaTypes[0] === "audio";
}

/**
 * Sets up Electron security policies on webContents, session, and downloads.
 */
function setupSecurityHandlers(options = {}) {
  const {
    mainWindow,
    getExpectedOrigin,
    shell,
    dialog,
    session: customSession,
    isTestMode = process.env.SUMI_TEST_MODE === "1",
    downloadDir = process.env.SUMI_TEST_DOWNLOAD_DIR,
  } = options;

  if (!mainWindow || !mainWindow.webContents) {
    throw new Error("setupSecurityHandlers requires a valid mainWindow with webContents");
  }

  const wc = mainWindow.webContents;
  const ses = customSession || wc.session;
  const activeDownloads = new Set();

  const getOrigin = () => {
    if (typeof getExpectedOrigin === "function") {
      return getExpectedOrigin();
    }
    return options.expectedOrigin || null;
  };

  // 1. Deny <webview> tags
  wc.on("will-attach-webview", (event) => {
    event.preventDefault();
  });

  // 2. Window creation handling: ALWAYS deny OS-opening popups.
  // Actual Electron 45.2.3 HandlerDetails ONLY has:
  //   { url, frameName, features, disposition, referrer: Referrer, postBody? }
  // There is NO details.initiator and NO details.frame - never read them.
  // Validating the referrer object here blocks legitimate links (missing referrer)
  // and can allow iframe-driven OS launches, so the popup handler never opens
  // anything: deliberate external opens go through the restricted preload IPC
  // path (sumi:open-external) validated in the main process instead.
  wc.setWindowOpenHandler(() => ({ action: "deny" }));

  // 3. Navigation handling:
  // Main frame: allow local same-origin navigation and about:blank.
  // External main-frame navigation is PREVENTED WITHOUT OS launch (deliberate
  // external opens are brokered via the trusted preload IPC path).
  // Subframes/iframes: always prevent, never launch OS browser.
  // Blob: URLs validate the embedded origin via URL(blob).origin.
  wc.on("will-navigate", (event, navUrl) => {
    const origin = getOrigin();

    // Handle blob: URLs first - validate embedded origin via URL().origin
    if (typeof navUrl === "string" && navUrl.startsWith("blob:")) {
      try {
        const blobUrl = new URL(navUrl);
        if (!origin || blobUrl.origin !== origin) {
          event.preventDefault();
        }
      } catch {
        event.preventDefault();
      }
      return;
    }

    if (event.isMainFrame) {
      if (navUrl === "about:blank" || (origin && validateOrigin(navUrl, origin))) {
        return; // Allow local same-origin main frame navigation
      }
      // External navigation: prevent WITHOUT OS launch
      event.preventDefault();
    } else {
      // Subframes/iframes must never navigate externally or launch OS browser
      event.preventDefault();
    }
  });

  // 4. Session permission request and check handlers.
  // Trusted webContents + main frame + EXACT origin required for both.
  // CHECK handler uses singular details.mediaType; REQUEST handler uses the
  // details.mediaTypes array. Camera ('video'), 'unknown' and iframes DENY.
  if (ses) {
    ses.setPermissionRequestHandler((requestingWc, permission, callback, details) => {
      const origin = getOrigin();
      if (requestingWc !== wc) return callback(false);
      if (!origin || !details || !validateOrigin(details.requestingUrl, origin))
        return callback(false);
      if (permission !== "media" && permission !== "microphone") return callback(false);
      if (!validatePermissionRequestDetails(details)) return callback(false);

      callback(true);
    });

    ses.setPermissionCheckHandler((checkingWc, permission, requestingOrigin, details) => {
      const origin = getOrigin();
      if (checkingWc !== wc) return false;
      if (!origin || requestingOrigin !== origin) return false;
      if (details && details.securityOrigin && details.securityOrigin !== origin) return false;
      if (details && details.requestingUrl && !validateOrigin(details.requestingUrl, origin))
        return false;
      if (permission !== "media" && permission !== "microphone") return false;
      return validatePermissionCheckDetails(details);
    });

    // 5. Native downloads handling (PDF/PNG/ZIP) - retained for GitHub/About/PDF flows
    ses.on("will-download", (event, item) => {
      const origin = getOrigin();
      const downloadUrl = item.getURL();
      // Same-origin blob: URLs validate the embedded origin via URL(blob).origin.
      // (DownloadItem.getOrigin is NOT a real Electron API - never use it.)
      let isTrustedLocal = false;
      if (typeof downloadUrl === "string" && downloadUrl.startsWith("blob:")) {
        try {
          isTrustedLocal = !!origin && new URL(downloadUrl).origin === origin;
        } catch {
          isTrustedLocal = false;
        }
      } else {
        isTrustedLocal = !!origin && validateOrigin(downloadUrl, origin);
      }

      // Deny downloads from untrusted sources
      if (!isTrustedLocal) {
        item.cancel();
        return;
      }

      activeDownloads.add(item);
      item.once("done", () => {
        activeDownloads.delete(item);
      });

      const filename = path.basename(item.getFilename() || "download");

      // In test mode: honor safe test download dir if absolute
      if (isTestMode && downloadDir && path.isAbsolute(downloadDir)) {
        item.setSavePath(path.join(downloadDir, filename));
        return;
      }

      // In production: prompt user with native save dialog
      if (dialog && typeof dialog.showSaveDialogSync === "function") {
        const chosen = dialog.showSaveDialogSync(mainWindow, {
          defaultPath: filename,
        });
        if (chosen) {
          item.setSavePath(chosen);
        } else {
          item.cancel();
        }
      }
    });
  }

  function cancelActiveDownloads() {
    for (const download of activeDownloads) {
      try {
        download.cancel();
      } catch {}
    }
    activeDownloads.clear();
  }

  return {
    cancelActiveDownloads,
    getActiveDownloadsCount: () => activeDownloads.size,
  };
}

module.exports = {
  validateOrigin,
  isTrustedSender,
  isSafeExternalUrl,
  validatePermissionCheckDetails,
  validatePermissionRequestDetails,
  setupSecurityHandlers,
};
