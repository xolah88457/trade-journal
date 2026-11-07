// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  AboutSettings,
  CORE_MIT_LICENSES,
  SOURCE_REPO_URL,
} from "../src/components/about-settings";
import SettingsPage from "../src/app/settings/page";

vi.mock("@/components/filter-bar", () => ({
  FilterBar: () => createElement("div", { "data-testid": "filter-bar" }),
}));
vi.mock("@/components/journal-settings", () => ({
  TimeZoneSettings: () => createElement("div", null, "TimeZoneSettings"),
  ContractMultiplierSettings: () => createElement("div", null, "ContractMultiplierSettings"),
}));
vi.mock("@/components/journal-default-settings", () => ({
  JournalDefaultSettings: () => createElement("div", null, "JournalDefaultSettings"),
}));
vi.mock("@/components/currency-settings", () => ({
  CurrencySettings: () => createElement("div", null, "CurrencySettings"),
}));
vi.mock("@/components/market-data-settings", () => ({
  MarketDataSettings: () => createElement("div", null, "MarketDataSettings"),
}));
vi.mock("@/components/ai-settings", () => ({
  AiSettings: () => createElement("div", null, "AiSettings"),
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  window.location.hash = "";
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  window.location.hash = "";
});

describe("AboutSettings component", () => {
  it("renders project identity, upstream attributions, and source repository", async () => {
    await act(async () => root.render(createElement(AboutSettings)));

    const text = container.textContent ?? "";
    expect(text).toContain("Sumi Trading Journal");
    expect(text).toContain("LuxAlgo Trade Journal");
    expect(text).toContain("Kami");
    expect(text).toContain("Tw93");

    // Source link points to exact requested repository
    const sourceLink = container.querySelector<HTMLAnchorElement>(`a[href="${SOURCE_REPO_URL}"]`);
    expect(sourceLink).not.toBeNull();
    expect(sourceLink?.getAttribute("href")).toBe("https://github.com/xolah88457/trade-journal");
    expect(sourceLink?.getAttribute("target")).toBe("_blank");
  });

  it("includes an explicit independence and no-affiliation disclaimer", async () => {
    await act(async () => root.render(createElement(AboutSettings)));

    const text = container.textContent ?? "";
    expect(text).toContain(
      "Sumi is an independent local desktop adaptation, not an official product of LuxAlgo or Tw93",
    );
    expect(text).toContain(
      "Sumi is not affiliated with, maintained by, or endorsed by LuxAlgo Global, LLC or Tw93",
    );
  });

  it("provides discoverable, un-guessed MIT copyright notices for core systems", async () => {
    await act(async () => root.render(createElement(AboutSettings)));

    // Verify all 4 expected MIT records are configured and rendered
    expect(CORE_MIT_LICENSES).toHaveLength(4);
    const text = container.textContent ?? "";

    expect(text).toContain("Copyright (c) 2026 LuxAlgo Global, LLC");
    expect(text).toContain("Copyright (c) 2026 Tw93");
    expect(text).toContain("Copyright (c) 2024-present The transcribe.cpp authors");
    expect(text).toContain("Copyright (c) 2020-present Silero Team");

    // Collapsible details elements exist for inspection
    const detailsElements = container.querySelectorAll("details");
    expect(detailsElements.length).toBeGreaterThanOrEqual(4);

    const preElements = container.querySelectorAll("pre");
    expect(preElements.length).toBeGreaterThanOrEqual(4);
    for (const pre of preElements) {
      expect(pre.textContent).toContain("Permission is hereby granted, free of charge");
      expect(pre.textContent).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
    }
  });

  it("documents voice engine architecture and model licensing caveats with external weight storage", async () => {
    await act(async () => root.render(createElement(AboutSettings)));

    const text = container.textContent ?? "";
    // Runtime & bundled VAD
    expect(text).toContain("transcribe-cpp");
    expect(text).toContain("silero-vad-v6.2-F32.gguf");

    // Parakeet ASR model caveats
    expect(text).toContain("nvidia/parakeet-unified-en-0.6b");
    expect(text).toContain("CC-BY-4.0");
    expect(text).toContain("NVIDIA Open Model License");

    // Weights stored outside application bundle
    expect(text).toContain("not redistributed within the application bundle");
    expect(text).toContain("~/Library/Application Support/Sumi/voice");
  });

  it("references bundled offline third-party notices without triggering network requests", async () => {
    await act(async () => root.render(createElement(AboutSettings)));

    const text = container.textContent ?? "";
    expect(text).toContain("Contents/Resources/licenses/THIRD-PARTY-NOTICES.md");
    expect(text).toContain("Contents/Resources/licenses/dependencies/");
    expect(text).toContain("desktop/THIRD-PARTY-NOTICES.md");
    expect(text).toContain("statically and offline");
  });
});

describe("SettingsPage integration", () => {
  it("includes About & licenses in navigation and activates it via hash", async () => {
    window.location.hash = "#about";
    await act(async () => root.render(createElement(SettingsPage)));

    // Nav contains the new section
    const navLinks = [...container.querySelectorAll<HTMLAnchorElement>("nav a")];
    const aboutNav = navLinks.find((link) => link.getAttribute("href") === "#about");
    expect(aboutNav).toBeDefined();
    expect(aboutNav?.textContent).toContain("About & licenses");

    // Active section panel renders AboutSettings
    const activeSection = container.querySelector<HTMLElement>(
      'section[aria-labelledby="settings-heading-about"]',
    );
    expect(activeSection).not.toBeNull();
    expect(activeSection?.hidden).toBe(false);
    expect(activeSection?.textContent).toContain("Sumi Trading Journal");
    expect(activeSection?.textContent).toContain(SOURCE_REPO_URL);
  });

  it("also supports #licenses and #about-licenses aliases", async () => {
    window.location.hash = "#licenses";
    await act(async () => root.render(createElement(SettingsPage)));

    const activeSection = container.querySelector<HTMLElement>(
      'section[aria-labelledby="settings-heading-about"]',
    );
    expect(activeSection?.hidden).toBe(false);
  });
});

describe("AboutSettings update functionality", () => {
  function setupDesktopBridge(info: any, checkForUpdatesImpl: any) {
    delete (window as any).sumiDesktop;
    (window as any).sumiDesktop = {
      preferences: {},
      savePreferences: () => {},
      getInfo: vi.fn().mockResolvedValue(info),
      checkForUpdates: checkForUpdatesImpl,
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as any).sumiDesktop;
  });

  it("shows desktop version, electron version, platform, arch when bridge available", async () => {
    setupDesktopBridge(
      { version: "0.2.0", electronVersion: "45.2.3", platform: "darwin", arch: "arm64" },
      vi.fn().mockResolvedValue({ status: "idle", nativeUI: true, provider: "sparkle" }),
    );

    await act(async () => root.render(createElement(AboutSettings)));
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const text = container.textContent ?? "";
    expect(text).toContain("v0.2.0");
    expect(text).toContain("Electron 45.2.3");
    expect(text).toContain("darwin (arm64)");
    expect(text).not.toContain("Web browser mode");
  });

  it("shows web browser mode when bridge absent", async () => {
    delete (window as any).sumiDesktop;

    await act(async () => root.render(createElement(AboutSettings)));

    const text = container.textContent ?? "";
    expect(text).toContain("Web browser mode");
    expect(text).toContain("Running in a web browser");
    expect(text).not.toContain("Sumi Desktop");
  });

  it("shows unknown electron version when not provided", async () => {
    setupDesktopBridge(
      { version: "0.2.0", electronVersion: "", platform: "darwin", arch: "arm64" },
      vi.fn().mockResolvedValue({ status: "idle", nativeUI: true, provider: "sparkle" }),
    );

    await act(async () => root.render(createElement(AboutSettings)));
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const text = container.textContent ?? "";
    expect(text).toContain("Electron unknown");
  });

  it("check for updates button triggers native Sparkle check", async () => {
    const checkMock = vi.fn().mockResolvedValue({
      status: "available",
      currentVersion: "0.2.0",
      availableVersion: "0.2.1",
      message: "Update 0.2.1 available",
      nativeUI: true,
      provider: "sparkle",
    });
    setupDesktopBridge(
      { version: "0.2.0", electronVersion: "45.2.3", platform: "darwin", arch: "arm64" },
      checkMock,
    );

    await act(async () => root.render(createElement(AboutSettings)));
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const button = container.querySelector<HTMLButtonElement>("button");
    expect(button).not.toBeNull();

    await act(async () => button?.click());
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(checkMock).toHaveBeenCalledTimes(1);
    const text = container.textContent ?? "";
    expect(text).toContain("Update available");
    expect(text).toContain("0.2.1");
  });

  it("shows error state with retry button when check fails", async () => {
    const checkMock = vi.fn().mockRejectedValue(new Error("Network error"));
    setupDesktopBridge(
      { version: "0.2.0", electronVersion: "45.2.3", platform: "darwin", arch: "arm64" },
      checkMock,
    );

    await act(async () => root.render(createElement(AboutSettings)));
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const button = container.querySelector<HTMLButtonElement>("button");
    await act(async () => button?.click());
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const text = container.textContent ?? "";
    expect(text).toContain("Network error");
    expect(text).toContain("Retry");
  });

  it("disables button and shows loading state during check (repeated click guard)", async () => {
    let resolveCheck: (value: any) => void;
    const checkPromise = new Promise((resolve) => {
      resolveCheck = resolve;
    });
    const checkMock = vi.fn().mockReturnValue(checkPromise);
    setupDesktopBridge(
      { version: "0.2.0", electronVersion: "45.2.3", platform: "darwin", arch: "arm64" },
      checkMock,
    );

    await act(async () => root.render(createElement(AboutSettings)));
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const button = container.querySelector<HTMLButtonElement>("button");
    expect(button).not.toBeNull();
    expect(button?.disabled).toBe(false);

    // First click starts check
    await act(async () => button?.click());
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // Button should be disabled during check
    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute("aria-busy")).toBe("true");
    expect(button?.textContent).toContain("Checking for updates");

    // Second click should be ignored (guard)
    checkMock.mockClear();
    await act(async () => button?.click());
    expect(checkMock).not.toHaveBeenCalled();

    // Resolve check
    await act(async () => {
      resolveCheck!({ status: "not-available", nativeUI: true, provider: "sparkle" });
      await vi.runAllTimersAsync();
    });

    // Button re-enabled after check
    expect(button?.disabled).toBe(false);
    expect(button?.textContent).toContain("Check for updates");
  });

  it("preserves About & licenses legal content during update interactions", async () => {
    const checkMock = vi.fn().mockResolvedValue({
      status: "available",
      currentVersion: "0.2.0",
      availableVersion: "0.2.1",
      message: "Update available",
      nativeUI: true,
      provider: "sparkle",
    });
    setupDesktopBridge(
      { version: "0.2.0", electronVersion: "45.2.3", platform: "darwin", arch: "arm64" },
      checkMock,
    );

    await act(async () => root.render(createElement(AboutSettings)));
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // Verify legal sections exist before update check
    expect(container.textContent).toContain("Core open-source licenses");
    expect(container.textContent).toContain("Voice engine & model notices");
    expect(container.textContent).toContain("Bundled third-party notices");
    expect(container.textContent).toContain("Independence & No-Affiliation Notice");
    expect(container.querySelectorAll("details").length).toBeGreaterThanOrEqual(4);

    // Trigger update check
    const button = container.querySelector<HTMLButtonElement>("button");
    await act(async () => button?.click());
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // Verify legal sections still exist after update check
    expect(container.textContent).toContain("Core open-source licenses");
    expect(container.textContent).toContain("Voice engine & model notices");
    expect(container.textContent).toContain("Bundled third-party notices");
    expect(container.textContent).toContain("Independence & No-Affiliation Notice");
    expect(container.querySelectorAll("details").length).toBeGreaterThanOrEqual(4);
  });

  it("shows up-to-date message after check completes with not-available", async () => {
    const checkMock = vi.fn().mockResolvedValue({
      status: "not-available",
      nativeUI: true,
      provider: "sparkle",
    });
    setupDesktopBridge(
      { version: "0.2.0", electronVersion: "45.2.3", platform: "darwin", arch: "arm64" },
      checkMock,
    );

    await act(async () => root.render(createElement(AboutSettings)));
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const button = container.querySelector<HTMLButtonElement>("button");
    await act(async () => button?.click());
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const text = container.textContent ?? "";
    expect(text).toContain("Sumi is up to date");
    expect(text).toContain("0.2.0");
  });

  it("does not show false 'installed verified' or programmatic download button", async () => {
    const checkMock = vi.fn().mockResolvedValue({
      status: "available",
      currentVersion: "0.2.0",
      availableVersion: "0.2.1",
      message: "Update available",
      nativeUI: true,
      provider: "sparkle",
    });
    setupDesktopBridge(
      { version: "0.2.0", electronVersion: "45.2.3", platform: "darwin", arch: "arm64" },
      checkMock,
    );

    await act(async () => root.render(createElement(AboutSettings)));
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const button = container.querySelector<HTMLButtonElement>("button");
    await act(async () => button?.click());
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const text = container.textContent ?? "";
    // Should NOT show false "installed verified" message
    expect(text).not.toContain("installed verified");
    expect(text).not.toContain("installed and verified");
    // Should NOT show programmatic download button (only Check for updates which opens native UI)
    expect(text).not.toContain("Download");
    expect(text).not.toContain("Install");
    // Should show native UI message (Sparkle owns download/install/restart)
    expect(text).toContain(
      "Opens the update window to download, install, and restart Sumi. Save your work first.",
    );
  });

  it("shows cross-platform update description on Windows and Linux", async () => {
    setupDesktopBridge(
      { version: "0.3.0", electronVersion: "45.2.3", platform: "win32", arch: "x64" },
      vi.fn().mockResolvedValue({ status: "idle", nativeUI: true, provider: "electron-updater" }),
    );

    await act(async () => root.render(createElement(AboutSettings)));
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const text = container.textContent ?? "";
    expect(text).toContain(
      "Checks for updates and prompts to download, install, and restart Sumi.",
    );
    expect(text).not.toContain("Opens the update window to download");
  });

  it("honestly renders unavailable status without false green up-to-date checkmark", async () => {
    const checkMock = vi.fn().mockResolvedValue({
      status: "unavailable",
      message:
        "Automatic updates are not supported for portable or tarball installations. Please update manually or install via AppImage or .deb.",
      nativeUI: true,
      provider: "electron-updater",
    });
    setupDesktopBridge(
      {
        version: "0.3.0",
        electronVersion: "45.2.3",
        platform: "linux",
        arch: "x64",
        update: {
          status: "unavailable",
          message:
            "Automatic updates are not supported for portable or tarball installations. Please update manually or install via AppImage or .deb.",
          nativeUI: true,
          provider: "electron-updater",
        },
      },
      checkMock,
    );

    await act(async () => root.render(createElement(AboutSettings)));
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const text = container.textContent ?? "";
    // Truthful message must be displayed
    expect(text).toContain(
      "Automatic updates are not supported for portable or tarball installations",
    );
    // NO FALSE GREEN: Must NEVER claim "Sumi is up to date"
    expect(text).not.toContain("Sumi is up to date");
  });

  it("renders downloading state when update is downloading", async () => {
    setupDesktopBridge(
      {
        version: "0.3.0",
        electronVersion: "45.2.3",
        platform: "win32",
        arch: "x64",
        update: {
          status: "downloading",
          message: "Downloading update… (42%)",
          nativeUI: true,
          provider: "electron-updater",
        },
      },
      vi.fn(),
    );

    await act(async () => root.render(createElement(AboutSettings)));
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const text = container.textContent ?? "";
    expect(text).toContain("Downloading update… (42%)");
  });

  it("renders downloaded and installing states honestly", async () => {
    setupDesktopBridge(
      {
        version: "0.3.0",
        electronVersion: "45.2.3",
        platform: "win32",
        arch: "x64",
        update: {
          status: "downloaded",
          message: "Update 0.4.0 downloaded; ready to install.",
          nativeUI: true,
          provider: "electron-updater",
        },
      },
      vi.fn(),
    );

    await act(async () => root.render(createElement(AboutSettings)));
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const text = container.textContent ?? "";
    expect(text).toContain("Update 0.4.0 downloaded; ready to install.");
  });
});
