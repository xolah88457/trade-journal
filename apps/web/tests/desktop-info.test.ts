// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  useDesktopInfo,
  getDesktopInfo,
  checkForDesktopUpdates,
  redactUpdateError,
  type AppInfo,
  type DesktopUpdateState,
} from "../src/lib/desktop-info";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  // Reset window.sumiDesktop
  delete (window as any).sumiDesktop;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete (window as any).sumiDesktop;
  vi.restoreAllMocks();
});

describe("redactUpdateError", () => {
  it("redacts macOS user paths", () => {
    expect(redactUpdateError("/Users/alice/Library/Application Support/Sumi/error.log")).toContain(
      "~",
    );
    expect(
      redactUpdateError("/Users/alice/Library/Application Support/Sumi/error.log"),
    ).not.toContain("alice");
  });

  it("redacts Linux user paths", () => {
    expect(redactUpdateError("/home/bob/.config/Sumi/error.log")).toContain("~");
    expect(redactUpdateError("/home/bob/.config/Sumi/error.log")).not.toContain("bob");
  });

  it("redacts Windows user paths", () => {
    expect(redactUpdateError("C:\\Users\\charlie\\AppData\\Roaming\\Sumi\\error.log")).toContain(
      "~",
    );
    expect(
      redactUpdateError("C:\\Users\\charlie\\AppData\\Roaming\\Sumi\\error.log"),
    ).not.toContain("charlie");
  });

  it("redacts URL query secrets", () => {
    expect(redactUpdateError("https://example.com?token=secret123&key=abc")).toContain(
      "[REDACTED]",
    );
    expect(redactUpdateError("https://example.com?token=secret123&key=abc")).not.toContain(
      "secret123",
    );
  });

  it("strips multiline stack traces to first line", () => {
    const multi =
      "Error: something failed\n    at foo (/path/to/file.js:1:1)\n    at bar (/path/to/file.js:2:2)";
    expect(redactUpdateError(multi)).toBe("Error: something failed");
  });

  it("bounds length to 200 chars", () => {
    const long = "a".repeat(250);
    expect(redactUpdateError(long).length).toBe(200);
  });

  it("handles null/undefined/Error objects", () => {
    expect(redactUpdateError(null)).toBe("");
    expect(redactUpdateError(undefined)).toBe("");
    expect(redactUpdateError(new Error("test error"))).toBe("test error");
  });
});

describe("getDesktopInfo", () => {
  it("returns null when bridge is absent", async () => {
    const result = await getDesktopInfo();
    expect(result).toBeNull();
  });

  it("returns null when getInfo is not a function", async () => {
    (window as any).sumiDesktop = { preferences: {}, savePreferences: () => {} };
    const result = await getDesktopInfo();
    expect(result).toBeNull();
  });

  it("returns parsed AppInfo when bridge returns valid data", async () => {
    const mockInfo = {
      version: "0.2.0",
      electronVersion: "45.2.3",
      platform: "darwin",
      arch: "arm64",
      update: { status: "idle", nativeUI: true, provider: "sparkle" },
    };
    (window as any).sumiDesktop = {
      preferences: {},
      savePreferences: () => {},
      getInfo: vi.fn().mockResolvedValue(mockInfo),
    };

    const result = await getDesktopInfo();
    expect(result).toEqual({
      version: "0.2.0",
      electronVersion: "45.2.3",
      platform: "darwin",
      arch: "arm64",
      update: { status: "idle", nativeUI: true, provider: "sparkle" },
    });
  });

  it("returns null when bridge returns invalid data (missing version)", async () => {
    (window as any).sumiDesktop = {
      preferences: {},
      savePreferences: () => {},
      getInfo: vi.fn().mockResolvedValue({ electronVersion: "45.2.3" }),
    };
    const result = await getDesktopInfo();
    expect(result).toBeNull();
  });

  it("returns null when bridge throws", async () => {
    (window as any).sumiDesktop = {
      preferences: {},
      savePreferences: () => {},
      getInfo: vi.fn().mockRejectedValue(new Error("IPC failed")),
    };
    const result = await getDesktopInfo();
    expect(result).toBeNull();
  });
});

describe("checkForDesktopUpdates", () => {
  it("throws when bridge is absent", async () => {
    await expect(checkForDesktopUpdates()).rejects.toThrow("Desktop bridge is not available");
  });

  it("throws when checkForUpdates is not a function", async () => {
    (window as any).sumiDesktop = { preferences: {}, savePreferences: () => {}, getInfo: () => {} };
    await expect(checkForDesktopUpdates()).rejects.toThrow("Desktop bridge is not available");
  });

  it("returns update state from bridge", async () => {
    const mockUpdate: DesktopUpdateState = {
      status: "available",
      currentVersion: "0.2.0",
      availableVersion: "0.2.1",
      message: "Update 0.2.1 is available",
      error: undefined,
      nativeUI: true,
      provider: "sparkle",
    };
    (window as any).sumiDesktop = {
      preferences: {},
      savePreferences: () => {},
      getInfo: () => {},
      checkForUpdates: vi.fn().mockResolvedValue(mockUpdate),
    };

    const result = await checkForDesktopUpdates();
    expect(result).toEqual(mockUpdate);
  });

  it("returns default idle state when bridge returns non-object", async () => {
    (window as any).sumiDesktop = {
      preferences: {},
      savePreferences: () => {},
      getInfo: () => {},
      checkForUpdates: vi.fn().mockResolvedValue(null),
    };

    const result = await checkForDesktopUpdates();
    expect(result).toEqual({ status: "idle", nativeUI: true, provider: "sparkle" });
  });
});

describe("useDesktopInfo hook", () => {
  function renderHook() {
    let result: ReturnType<typeof useDesktopInfo>;
    const TestComponent = () => {
      result = useDesktopInfo();
      return createElement("div", null, "test");
    };
    act(() => root.render(createElement(TestComponent)));
    // Live getter: state values change on re-render, so assertions must read
    // hook.current after act(...) rather than a destructured initial snapshot.
    return {
      get current() {
        return result!;
      },
    };
  }

  it("returns isDesktop=false when bridge absent", () => {
    const hook = renderHook();
    expect(hook.current.isDesktop).toBe(false);
  });

  it("returns isDesktop=true when bridge present", () => {
    (window as any).sumiDesktop = {
      preferences: {},
      savePreferences: () => {},
      getInfo: vi.fn().mockResolvedValue({
        version: "0.2.0",
        electronVersion: "45.2.3",
        platform: "darwin",
        arch: "arm64",
      }),
      checkForUpdates: vi
        .fn()
        .mockResolvedValue({ status: "idle", nativeUI: true, provider: "sparkle" }),
    };
    const hook = renderHook();
    expect(hook.current.isDesktop).toBe(true);
  });

  it("loads info on mount when bridge present", async () => {
    const mockInfo: AppInfo = {
      version: "0.2.0",
      electronVersion: "45.2.3",
      platform: "darwin",
      arch: "arm64",
    };
    (window as any).sumiDesktop = {
      preferences: {},
      savePreferences: () => {},
      getInfo: vi.fn().mockResolvedValue(mockInfo),
      checkForUpdates: vi
        .fn()
        .mockResolvedValue({ status: "idle", nativeUI: true, provider: "sparkle" }),
    };

    const hook = renderHook();
    expect(hook.current.isLoading).toBe(true);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(hook.current.info).toEqual(mockInfo);
    expect(hook.current.isLoading).toBe(false);
  });

  it("does not auto-check updates on mount", async () => {
    const checkForUpdatesMock = vi
      .fn()
      .mockResolvedValue({ status: "idle", nativeUI: true, provider: "sparkle" });
    (window as any).sumiDesktop = {
      preferences: {},
      savePreferences: () => {},
      getInfo: vi.fn().mockResolvedValue({
        version: "0.2.0",
        electronVersion: "45.2.3",
        platform: "darwin",
        arch: "arm64",
      }),
      checkForUpdates: checkForUpdatesMock,
    };

    renderHook();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(checkForUpdatesMock).not.toHaveBeenCalled();
  });

  it("checkForUpdates calls bridge and updates state", async () => {
    const mockUpdate: DesktopUpdateState = {
      status: "available",
      currentVersion: "0.2.0",
      availableVersion: "0.2.1",
      message: "Update available",
      error: undefined,
      nativeUI: true,
      provider: "sparkle",
    };
    const checkForUpdatesMock = vi.fn().mockResolvedValue(mockUpdate);
    (window as any).sumiDesktop = {
      preferences: {},
      savePreferences: () => {},
      getInfo: vi.fn().mockResolvedValue({
        version: "0.2.0",
        electronVersion: "45.2.3",
        platform: "darwin",
        arch: "arm64",
      }),
      checkForUpdates: checkForUpdatesMock,
    };

    const hook = renderHook();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(hook.current.isChecking).toBe(false);
    await act(async () => {
      await hook.current.checkForUpdates();
    });

    expect(checkForUpdatesMock).toHaveBeenCalledTimes(1);
    expect(hook.current.isChecking).toBe(false);
    expect(hook.current.info?.update).toEqual(mockUpdate);
    expect(hook.current.checkCompletionKey).toBe(1);
  });

  it("sets error when bridge returns error status", async () => {
    const checkForUpdatesMock = vi.fn().mockResolvedValue({
      status: "error",
      error: "Network error",
      message: "Failed",
      nativeUI: true,
      provider: "sparkle",
    });
    (window as any).sumiDesktop = {
      preferences: {},
      savePreferences: () => {},
      getInfo: vi.fn().mockResolvedValue({
        version: "0.2.0",
        electronVersion: "45.2.3",
        platform: "darwin",
        arch: "arm64",
      }),
      checkForUpdates: checkForUpdatesMock,
    };

    const hook = renderHook();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    await act(async () => {
      await hook.current.checkForUpdates();
    });

    expect(hook.current.error).toContain("Network error");
    expect(hook.current.isChecking).toBe(false);
  });

  it("sets error when bridge throws", async () => {
    const checkForUpdatesMock = vi.fn().mockRejectedValue(new Error("IPC timeout"));
    (window as any).sumiDesktop = {
      preferences: {},
      savePreferences: () => {},
      getInfo: vi.fn().mockResolvedValue({
        version: "0.2.0",
        electronVersion: "45.2.3",
        platform: "darwin",
        arch: "arm64",
      }),
      checkForUpdates: checkForUpdatesMock,
    };

    const hook = renderHook();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    await act(async () => {
      await hook.current.checkForUpdates();
    });

    expect(hook.current.error).toContain("IPC timeout");
  });

  it("guards against repeated clicks during check", async () => {
    let resolveCheck: (value: any) => void;
    const checkPromise = new Promise((resolve) => {
      resolveCheck = resolve;
    });
    const checkForUpdatesMock = vi.fn().mockReturnValue(checkPromise);
    (window as any).sumiDesktop = {
      preferences: {},
      savePreferences: () => {},
      getInfo: vi.fn().mockResolvedValue({
        version: "0.2.0",
        electronVersion: "45.2.3",
        platform: "darwin",
        arch: "arm64",
      }),
      checkForUpdates: checkForUpdatesMock,
    };

    const hook = renderHook();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    let first: Promise<void>;
    let second: Promise<void>;
    await act(async () => {
      first = hook.current.checkForUpdates();
      second = hook.current.checkForUpdates();
    });
    expect(hook.current.isChecking).toBe(true);
    expect(checkForUpdatesMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveCheck!({ status: "idle", nativeUI: true, provider: "sparkle" });
      await first!;
      await second!;
    });
    expect(hook.current.isChecking).toBe(false);
  });

  it("increments checkCompletionKey on each check", async () => {
    const checkForUpdatesMock = vi
      .fn()
      .mockResolvedValueOnce({ status: "not-available", nativeUI: true, provider: "sparkle" })
      .mockResolvedValueOnce({ status: "not-available", nativeUI: true, provider: "sparkle" });
    (window as any).sumiDesktop = {
      preferences: {},
      savePreferences: () => {},
      getInfo: vi.fn().mockResolvedValue({
        version: "0.2.0",
        electronVersion: "45.2.3",
        platform: "darwin",
        arch: "arm64",
      }),
      checkForUpdates: checkForUpdatesMock,
    };

    const hook = renderHook();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(hook.current.checkCompletionKey).toBe(0);
    await act(async () => {
      await hook.current.checkForUpdates();
    });
    expect(hook.current.checkCompletionKey).toBe(1);
    await act(async () => {
      await hook.current.checkForUpdates();
    });
    expect(hook.current.checkCompletionKey).toBe(2);
  });

  it("cleans up on unmount", async () => {
    (window as any).sumiDesktop = {
      preferences: {},
      savePreferences: () => {},
      getInfo: vi.fn().mockResolvedValue({
        version: "0.2.0",
        electronVersion: "45.2.3",
        platform: "darwin",
        arch: "arm64",
      }),
      checkForUpdates: vi
        .fn()
        .mockResolvedValue({ status: "idle", nativeUI: true, provider: "sparkle" }),
    };

    const hook = renderHook();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    await act(async () => root.unmount());

    // After unmount, checkForUpdates should not throw or update state
    await act(async () => {
      await hook.current.checkForUpdates();
    });
    // No assertions needed - just verify no crash
  });
});
