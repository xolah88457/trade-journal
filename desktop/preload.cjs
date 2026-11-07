"use strict";

const { contextBridge, ipcRenderer, webFrame } = require("electron");

// Preload ONLY in the main trusted frame; deny subframes/iframes
const isMainFrame = process.isMainFrame ?? (webFrame ? webFrame.top === null : true);

if (isMainFrame) {
  // Retrieve initial preferences synchronously from the main process cache (fast, no disk I/O)
  let initialPreferences = {};
  try {
    const synced = ipcRenderer.sendSync("sumi:get-preferences-sync");
    if (synced && typeof synced === "object" && !Array.isArray(synced)) {
      initialPreferences = synced;
    }
  } catch (err) {
    console.error("[preload] Failed to retrieve synchronous preferences:", err);
  }

  // Broker external anchor clicks from the trusted main document, REGARDLESS of
  // target (plain <a href> with no target, _self, _blank - e.g. rich-editor
  // user-note/review links render plain external anchors). The window-open
  // handler in the main process ALWAYS denies popups and will-navigate prevents
  // external in-shell navigation without OS launch, so a real user click on an
  // external http/https/mailto anchor is routed here through the restricted
  // internal IPC channel "sumi:open-external", which the main process
  // re-validates (trusted main-frame sender + safe URL, no credentials) before
  // shell.openExternal. Same-origin anchors keep fully native behavior
  // (will-navigate allows same-origin main-frame nav, downloads and blob: flow
  // through will-download) - only same-origin target=_blank popups are re-routed
  // to local navigation because the popup handler denies them.
  // Only isTrusted (real user) left clicks are handled; synthetic clicks fall
  // through to the always-deny popup handler / prevented navigation.
  // No raw ipcRenderer is exposed to the page.
  document.addEventListener(
    "click",
    (event) => {
      try {
        if (!event.isTrusted || event.defaultPrevented || event.button !== 0) return;
        const target = event.target;
        const anchor =
          target && typeof target.closest === "function" ? target.closest("a[href]") : null;
        if (!anchor) return;
        const href = anchor.getAttribute("href");
        if (!href) return;
        const resolved = new URL(href, window.location.href);
        const sameOrigin = resolved.origin === window.location.origin;
        const anchorTarget = anchor.getAttribute("target");
        const popupTarget = !!anchorTarget && anchorTarget !== "_self";

        if (sameOrigin) {
          // Same-origin: native navigation/downloads/blob stay untouched,
          // except target=_blank which the popup handler always denies.
          if (popupTarget) {
            event.preventDefault();
            window.location.assign(resolved.href);
          }
          return;
        }

        if (
          resolved.protocol === "https:" ||
          resolved.protocol === "http:" ||
          resolved.protocol === "mailto:"
        ) {
          if (resolved.username || resolved.password) return; // credentials forbidden -> deny
          // External deliberate user click (any target incl. none/_self/_blank)
          event.preventDefault();
          ipcRenderer.send("sumi:open-external", resolved.href);
        }
        // Other protocols (javascript:, file:, cross-origin blob:) fall through;
        // the always-deny popup handler and prevented will-navigate cover them.
      } catch {
        // Never break the page on broker failure
      }
    },
    true,
  );

  // Expose narrow, secure API on window.sumiDesktop
  // No event forwarding, no raw IPC, no file paths, no shell or node builtins exposed.
  contextBridge.exposeInMainWorld("sumiDesktop", {
    preferences: Object.freeze({ ...initialPreferences }),

    savePreferences(dict) {
      if (!dict || typeof dict !== "object" || Array.isArray(dict)) return;
      ipcRenderer.send("sumi:save-preferences", dict);
    },

    getInfo() {
      return ipcRenderer.invoke("sumi:get-info");
    },

    checkForUpdates() {
      return ipcRenderer.invoke("sumi:check-for-updates");
    },
  });
}
