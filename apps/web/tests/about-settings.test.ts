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
