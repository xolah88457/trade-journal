"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getSumiDesktop, isSumiDesktop } from "./desktop-preferences";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "error"
  | "unavailable"
  | string;

/**
 * Update state contract — matches electron-sparkle native binding contract.
 * Source of truth: desktop/update-service.cjs createUpdateService.getState()
 */
export interface DesktopUpdateState {
  status: UpdateStatus;
  currentVersion?: string;
  availableVersion?: string;
  message?: string;
  error?: string;
  nativeUI: boolean;
  provider: "sparkle" | "electron-updater" | string;
}

/**
 * App runtime info contract — matches desktop/main.cjs sumi:get-info response.
 * Source of truth: desktop/main.cjs registerIpcHandlers -> sumi:get-info
 */
export interface AppInfo {
  version: string;
  electronVersion: string;
  platform: string;
  arch: string;
  update?: DesktopUpdateState;
}

export interface UseDesktopInfoResult {
  isDesktop: boolean;
  info: AppInfo | null;
  isLoading: boolean;
  isChecking: boolean;
  error: string | null;
  checkCompletionKey: number;
  lastChecked: Date | null;
  checkForUpdates: () => Promise<void>;
}

/**
 * Safely sanitizes and redacts update error messages to prevent leakage of
 * local file paths or private information while remaining informative.
 */
export function redactUpdateError(raw: unknown): string {
  if (!raw) return "";
  let message =
    typeof raw === "string"
      ? raw
      : raw instanceof Error
        ? raw.message
        : typeof (raw as { message?: unknown }).message === "string"
          ? String((raw as { message?: unknown }).message)
          : String(raw);

  // Redact macOS and Linux home directory user paths (/Users/<user> or /home/<user>)
  message = message.replace(/(?:\/Users|\/home)\/[^/\s]+/g, "~");
  // Redact Windows user paths (C:\Users\<user>)
  message = message.replace(/[A-Za-z]:\\Users\\[^\s\\]+/gi, "~");
  // Redact URL query sensitive parameters
  message = message.replace(/([?&](?:token|key|secret|auth)=)[^&\s]+/gi, "$1[REDACTED]");
  // Strip multiline stack traces (keep first line)
  const firstLine = message.split("\n")[0] ?? "";
  message = firstLine.trim();
  // Bounded length
  if (message.length > 200) {
    message = message.slice(0, 197) + "...";
  }
  return message;
}

/**
 * Reads local runtime info from the desktop bridge.
 * Purely local IPC on mount — does not call background update servers.
 */
export async function getDesktopInfo(): Promise<AppInfo | null> {
  const desktop = getSumiDesktop();
  if (!desktop || typeof desktop.getInfo !== "function") {
    return null;
  }
  try {
    const raw = await desktop.getInfo();
    if (!raw || typeof raw !== "object" || typeof raw.version !== "string") {
      return null;
    }
    return {
      version: String(raw.version),
      electronVersion: typeof raw.electronVersion === "string" ? raw.electronVersion : "",
      platform: typeof raw.platform === "string" ? raw.platform : "",
      arch: typeof raw.arch === "string" ? raw.arch : "",
      update:
        raw.update && typeof raw.update === "object"
          ? (raw.update as DesktopUpdateState)
          : undefined,
    };
  } catch (err) {
    console.error("[desktop-info] Failed to read desktop info:", err);
    return null;
  }
}

/**
 * Invokes the desktop update check via window.sumiDesktop.checkForUpdates().
 * Handled natively by Sparkle inside Electron which manages checking, downloading,
 * installing, and restarting without requiring unsupported web download APIs.
 * No automatic background checks — only user-initiated.
 */
export async function checkForDesktopUpdates(): Promise<DesktopUpdateState> {
  const desktop = getSumiDesktop();
  if (!desktop || typeof desktop.checkForUpdates !== "function") {
    throw new Error("Desktop bridge is not available");
  }
  const result = await desktop.checkForUpdates();
  if (result && typeof result === "object") {
    return result as DesktopUpdateState;
  }
  return { status: "idle", nativeUI: true, provider: "sparkle" };
}

/**
 * React hook to manage desktop information, safe local mount querying,
 * update checks, and unmount cancellation protection.
 */
export function useDesktopInfo(): UseDesktopInfoResult {
  const [isDesktop, setIsDesktop] = useState<boolean>(() => isSumiDesktop());
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isChecking, setIsChecking] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [checkCompletionKey, setCheckCompletionKey] = useState<number>(0);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);

  const mountedRef = useRef<boolean>(true);
  const isCheckingRef = useRef<boolean>(false);

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;

    const desktopAvailable = isSumiDesktop();
    setIsDesktop(desktopAvailable);

    if (!desktopAvailable) {
      setIsLoading(false);
      return;
    }

    async function load() {
      try {
        const data = await getDesktopInfo();
        if (!cancelled && mountedRef.current) {
          setInfo(data);
          setIsLoading(false);
        }
      } catch {
        if (!cancelled && mountedRef.current) {
          setIsLoading(false);
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
      mountedRef.current = false;
    };
  }, []);

  const checkForUpdates = useCallback(async () => {
    if (isCheckingRef.current) return;
    if (!isSumiDesktop()) return;

    isCheckingRef.current = true;
    setIsChecking(true);
    setError(null);

    try {
      const updateState = await checkForDesktopUpdates();
      if (!mountedRef.current) return;

      if (updateState.status === "error" || updateState.error) {
        setError(
          redactUpdateError(updateState.error || updateState.message || "Update check failed"),
        );
      } else {
        setInfo((prev) => (prev ? { ...prev, update: updateState } : prev));
      }
      setLastChecked(new Date());
    } catch (err) {
      if (!mountedRef.current) return;
      setError(redactUpdateError(err));
    } finally {
      if (mountedRef.current) {
        isCheckingRef.current = false;
        setIsChecking(false);
        setCheckCompletionKey((k) => k + 1);
      }
    }
  }, []);

  return {
    isDesktop,
    info,
    isLoading,
    isChecking,
    error,
    checkCompletionKey,
    lastChecked,
    checkForUpdates,
  };
}
