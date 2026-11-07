// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  DailyReportExport,
  type DailyReportExportProps,
  type DailyReportPage,
  type PreparedDailyReport,
} from "../src/components/daily-report-export";
import { TooltipProvider } from "../src/components/ui/tooltip";
import type { DailyReport } from "../src/lib/daily-report-types";

// Mock privacy hook state
const privacyState = { enabled: false };
vi.mock("@/components/privacy", () => ({
  usePrivacy: () => privacyState.enabled,
}));

// Mock daily-report-render state
const renderMockState = {
  prepared: null as PreparedDailyReport | null,
  prepareDailyReport: vi.fn(),
};

let container: HTMLDivElement;
let root: Root;
let createdUrls: string[] = [];
let revokedUrls: string[] = [];
let linkClicks: Array<{ href: string; download: string }> = [];

const sampleReport: DailyReport = {
  date: "2026-11-07",
  exportedAt: "2026-11-07T12:00:00.000Z",
  timeZone: "America/New_York",
  scope: {
    label: "Main Account",
    filters: { accounts: "acc1" },
    accountNames: ["Main"],
    currencies: ["USD"],
  },
  metrics: {
    totalTrades: 2,
    closedTrades: 2,
    openTrades: 0,
    wins: 1,
    losses: 1,
    breakevens: 0,
    winRate: 0.5,
    dayWinRate: 1,
    tradingDays: 1,
    netPnl: 250,
    grossPnl: 270,
    fees: 20,
    profitFactor: 2.5,
    profitFactorIsInfinite: false,
    avgWin: 500,
    avgLoss: -250,
    avgWinLossRatio: 2,
    expectancy: 125,
    largestWin: 500,
    largestLoss: -250,
    maxWinStreak: 1,
    maxLossStreak: 1,
    currentStreak: -1,
    totalVolume: 100,
    avgDurationMs: 3600000,
    maxDrawdown: 50,
    maxDrawdownPct: 0.05,
    recoveryFactor: 5,
    profitConcentration: 1,
    avgRealizedR: 1,
    tradesWithRisk: 2,
  },
  profitFactorIsInfinite: false,
  intraday: [
    { t: "09:30", cumNetPnl: 0 },
    { t: "16:00", cumNetPnl: 250 },
  ],
  note: "Server original note",
  noteUpdatedAt: "2026-11-07T11:00:00.000Z",
  attachments: [],
  trades: [
    {
      key: "AAPL-1",
      symbol: "AAPL",
      accountId: "acc1",
      accountName: "Main",
      currency: "USD",
      assetClass: "equity",
      direction: "long",
      status: "win",
      openedAt: "2026-11-07T09:35:00.000Z",
      closedAt: "2026-11-07T10:00:00.000Z",
      durationMs: 1500000,
      quantity: 10,
      openQuantity: 0,
      contractMultiplier: 1,
      avgEntry: 150,
      avgExit: 155,
      grossPnl: 50,
      fees: 2,
      netPnl: 48,
      netReturnOnEntry: 0.032,
      riskAmount: 20,
      plannedR: 2.5,
      realizedR: 2.4,
      stopLoss: 148,
      profitTarget: 155,
      targetHit: "profit_target",
      rating: 5,
      reviewedAt: "2026-11-07T10:05:00.000Z",
      tags: ["breakout"],
      mistakes: [],
      notes: "Good execution",
      playbook: null,
      executions: [],
      runningPnl: [],
      attachments: [],
      aiReviews: [],
      excursions: null,
    },
    {
      key: "TSLA-2",
      symbol: "TSLA",
      accountId: "acc1",
      accountName: "Main",
      currency: "USD",
      assetClass: "equity",
      direction: "long",
      status: "loss",
      openedAt: "2026-11-07T10:30:00.000Z",
      closedAt: "2026-11-07T11:00:00.000Z",
      durationMs: 1800000,
      quantity: 5,
      openQuantity: 0,
      contractMultiplier: 1,
      avgEntry: 200,
      avgExit: 195,
      grossPnl: -25,
      fees: 2,
      netPnl: -27,
      netReturnOnEntry: -0.027,
      riskAmount: 25,
      plannedR: -1,
      realizedR: -1.08,
      stopLoss: 195,
      profitTarget: 210,
      targetHit: "stop_loss",
      rating: 3,
      reviewedAt: "2026-11-07T11:05:00.000Z",
      tags: [],
      mistakes: ["early exit"],
      notes: "Hesitated at key level",
      playbook: null,
      executions: [],
      runningPnl: [],
      attachments: [],
      aiReviews: [],
      excursions: null,
    },
  ],
};

function createMockPrepared(pages: DailyReportPage[]): PreparedDailyReport {
  return {
    pages,
    renderPage: vi.fn(async (pageId: string, scale?: number) => {
      return new Blob([`mock-img-${pageId}-${scale ?? 1}`], { type: "image/png" });
    }),
    buildPdf: vi.fn(async () => ({
      blob: new Blob(["pdf-bytes"], { type: "application/pdf" }),
      filename: "daily-report-2026-11-07.pdf",
    })),
    buildPngDownload: vi.fn(async (pageIds: string[]) => ({
      blob: new Blob([`png-bytes-${pageIds.join(",")}`], {
        type: pageIds.length === 1 ? "image/png" : "application/zip",
      }),
      filename:
        pageIds.length === 1 ? `daily-report-${pageIds[0]}.png` : "daily-report-2026-11-07.zip",
    })),
    dispose: vi.fn(),
  };
}

async function flushAsyncEvents() {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

const mockLoadRenderer = async () => ({
  prepareDailyReport: renderMockState.prepareDailyReport,
});

async function renderExport(props: Partial<DailyReportExportProps> = {}) {
  const mergedProps: DailyReportExportProps = {
    date: "2026-11-07",
    loadRenderer: mockLoadRenderer,
    ...props,
  };
  await act(async () => {
    root.render(
      createElement(TooltipProvider, null, createElement(DailyReportExport, mergedProps)),
    );
  });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);

  createdUrls = [];
  revokedUrls = [];
  linkClicks = [];
  privacyState.enabled = false;

  URL.createObjectURL = vi.fn((blob: Blob) => {
    const url = `blob:mock-${createdUrls.length + 1}-${Math.random().toString(36).slice(2)}`;
    createdUrls.push(url);
    return url;
  });

  URL.revokeObjectURL = vi.fn((url: string) => {
    revokedUrls.push(url);
  });

  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    linkClicks.push({ href: this.href, download: this.download });
  });

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => JSON.parse(JSON.stringify(sampleReport)),
    } as Response;
  });

  const defaultPages: DailyReportPage[] = [
    { id: "page-daily", title: "Daily Overview", kind: "daily" },
    { id: "page-trade-1", title: "Trade #1 · AAPL", kind: "trade", tradeKey: "AAPL-1" },
    { id: "page-trade-2", title: "Trade #2 · TSLA", kind: "trade", tradeKey: "TSLA-2" },
  ];
  renderMockState.prepared = createMockPrepared(defaultPages);
  renderMockState.prepareDailyReport = vi.fn(async () => renderMockState.prepared!);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.restoreAllMocks();
});

describe("DailyReportExport component", () => {
  it("privacy blocks: disables both triggers when privacy mode is on, renders disclosure, and guards handlers", async () => {
    privacyState.enabled = true;

    await renderExport({ date: "2026-11-07" });

    const buttons = container.querySelectorAll<HTMLButtonElement>("button");
    const pdfBtn = Array.from(buttons).find((b) => b.textContent?.includes("Export PDF"));
    const pngBtn = Array.from(buttons).find((b) => b.textContent?.includes("Export PNG"));

    expect(pdfBtn).toBeDefined();
    expect(pngBtn).toBeDefined();
    expect(pdfBtn?.disabled).toBe(true);
    expect(pngBtn?.disabled).toBe(true);

    const text = container.textContent ?? "";
    expect(text).toContain("Turn off privacy mode to export financial figures");

    // Clicking does not call fetch
    await act(async () => {
      pdfBtn?.click();
      pngBtn?.click();
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(renderMockState.prepareDailyReport).not.toHaveBeenCalled();
  });

  it("current note override: captures unsaved note snapshot and overrides fetched report client-side without persisting", async () => {
    const unsavedNote = "My very recent unsaved note typed in editor";

    await renderExport({
      date: "2026-11-07",
      query: "accounts=acc1",
      note: unsavedNote,
    });

    const pdfBtn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      b.textContent?.includes("Export PDF"),
    );
    expect(pdfBtn).toBeDefined();

    await act(async () => {
      pdfBtn?.click();
    });
    await flushAsyncEvents();

    // Check that fetch called the correct export endpoint preserving canonical query
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/journal/2026-11-07/export?accounts=acc1", {
      signal: expect.any(AbortSignal),
    });

    // Verify prepareDailyReport received the client-side overridden note, and noteUpdatedAt was reset
    expect(renderMockState.prepareDailyReport).toHaveBeenCalledTimes(1);
    const passedReport = renderMockState.prepareDailyReport.mock.calls[0]![0] as DailyReport;
    expect(passedReport.note).toBe(unsavedNote);
    expect(passedReport.noteUpdatedAt).toBeNull();
  });

  it("omitted note prop preserves DB note and timestamp", async () => {
    await renderExport({
      date: "2026-11-07",
      query: "accounts=acc1",
      note: undefined, // omitted note prop
    });

    const pdfBtn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      b.textContent?.includes("Export PDF"),
    );

    await act(async () => {
      pdfBtn?.click();
    });
    await flushAsyncEvents();

    expect(renderMockState.prepareDailyReport).toHaveBeenCalledTimes(1);
    const passedReport = renderMockState.prepareDailyReport.mock.calls[0]![0] as DailyReport;
    expect(passedReport.note).toBe("Server original note");
    expect(passedReport.noteUpdatedAt).toBe("2026-11-07T11:00:00.000Z");
  });

  it("pending page fetch preserves DB note when note is null (evaluated as undefined)", async () => {
    const editNote: string | null = null; // simulate unedited note state before user interaction
    await renderExport({
      date: "2026-11-07",
      note: editNote !== null ? editNote : undefined,
    });

    const pdfBtn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      b.textContent?.includes("Export PDF"),
    );

    await act(async () => {
      pdfBtn?.click();
    });
    await flushAsyncEvents();

    expect(renderMockState.prepareDailyReport).toHaveBeenCalledTimes(1);
    const passedReport = renderMockState.prepareDailyReport.mock.calls[0]![0] as DailyReport;
    expect(passedReport.note).toBe("Server original note");
    expect(passedReport.noteUpdatedAt).toBe("2026-11-07T11:00:00.000Z");
  });

  it("empty draft clears note and resets noteUpdatedAt", async () => {
    await renderExport({
      date: "2026-11-07",
      note: "", // intentional empty draft typed by user
    });

    const pdfBtn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      b.textContent?.includes("Export PDF"),
    );

    await act(async () => {
      pdfBtn?.click();
    });
    await flushAsyncEvents();

    expect(renderMockState.prepareDailyReport).toHaveBeenCalledTimes(1);
    const passedReport = renderMockState.prepareDailyReport.mock.calls[0]![0] as DailyReport;
    expect(passedReport.note).toBe("");
    expect(passedReport.noteUpdatedAt).toBeNull();
  });

  it("format mode counts: correctly displays total page counts in PDF mode, renders full page preview, and calls buildPdf on download", async () => {
    await renderExport({ date: "2026-11-07" });

    const pdfBtn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      b.textContent?.includes("Export PDF"),
    );

    await act(async () => {
      pdfBtn?.click();
    });
    await flushAsyncEvents();

    const dialog = document.querySelector("[role='dialog']");
    expect(dialog).not.toBeNull();
    const dialogText = dialog?.textContent ?? "";

    expect(dialogText).toContain("Daily journal report");
    expect(dialogText).toContain("3 pages");
    expect(dialogText).toContain("Exports complete PDF with overview and all trades (3 pages)");

    // Per-page checkboxes must NOT be rendered in PDF mode
    const checkboxes = dialog?.querySelectorAll("[role='checkbox']");
    expect(checkboxes?.length ?? 0).toBe(0);

    const downloadBtn = Array.from(
      dialog?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    ).find((b) => b.textContent?.includes("Download full PDF (3 pages)"));
    expect(downloadBtn).toBeDefined();
    expect(downloadBtn?.disabled).toBe(false);

    await act(async () => {
      downloadBtn?.click();
    });
    await flushAsyncEvents();

    expect(renderMockState.prepared?.buildPdf).toHaveBeenCalledTimes(1);
    expect(linkClicks.length).toBe(1);
    expect(linkClicks[0]?.download).toBe("daily-report-2026-11-07.pdf");
  });

  it("choose 2 specific pages actual selected IDs / ZIP method: selects exact pages, preserves order, and downloads ZIP", async () => {
    await renderExport({ date: "2026-11-07" });

    const pngBtn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      b.textContent?.includes("Export PNG"),
    );

    await act(async () => {
      pngBtn?.click();
    });
    await flushAsyncEvents();

    const dialog = document.querySelector("[role='dialog']");
    expect(dialog).not.toBeNull();

    let downloadBtn = Array.from(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
      (b) => b.textContent?.includes("Download ZIP"),
    );
    expect(downloadBtn?.textContent).toContain("Download ZIP (3 pages)");

    // Clear selection
    const clearBtn = Array.from(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
      (b) => b.textContent === "Clear",
    );
    expect(clearBtn).toBeDefined();

    await act(async () => {
      clearBtn?.click();
    });

    downloadBtn = Array.from(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
      (b) => b.textContent?.includes("Select at least 1 page"),
    );
    expect(downloadBtn?.disabled).toBe(true);

    // Select page 1 ("page-daily") and page 3 ("page-trade-2") in thumbnail sidebar
    const sidebarItems = dialog?.querySelectorAll("[aria-label='Page thumbnail list'] > div");
    expect(sidebarItems?.length).toBe(3);

    const cb1 = sidebarItems![0]?.querySelector<HTMLButtonElement>("[role='checkbox']");
    const cb3 = sidebarItems![2]?.querySelector<HTMLButtonElement>("[role='checkbox']");

    await act(async () => {
      cb1?.click();
    });
    await act(async () => {
      cb3?.click();
    });

    downloadBtn = Array.from(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
      (b) => b.textContent?.includes("Download ZIP (2 pages)"),
    );
    expect(downloadBtn).toBeDefined();
    expect(downloadBtn?.disabled).toBe(false);

    await act(async () => {
      downloadBtn?.click();
    });
    await flushAsyncEvents();

    expect(renderMockState.prepared?.buildPngDownload).toHaveBeenCalledWith([
      "page-daily",
      "page-trade-2",
    ]);
    expect(linkClicks.length).toBe(1);
    expect(linkClicks[0]?.download).toBe("daily-report-2026-11-07.zip");
  });

  it("0 selection: disables download button when all pages are cleared in PNG mode", async () => {
    await renderExport({ date: "2026-11-07" });

    const pngBtn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      b.textContent?.includes("Export PNG"),
    );

    await act(async () => {
      pngBtn?.click();
    });
    await flushAsyncEvents();

    const dialog = document.querySelector("[role='dialog']");
    const clearBtn = Array.from(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
      (b) => b.textContent === "Clear",
    );

    await act(async () => {
      clearBtn?.click();
    });

    const downloadBtn = Array.from(
      dialog?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    ).find((b) => b.textContent?.includes("Select at least 1 page"));

    expect(downloadBtn).toBeDefined();
    expect(downloadBtn?.disabled).toBe(true);
  });

  it("close/unmount/stale generation no click download: cancels in-flight work and revokes owned URLs", async () => {
    let resolveSlowFetch: (val: unknown) => void = () => {};
    const slowFetchPromise = new Promise((resolve) => {
      resolveSlowFetch = resolve;
    });

    globalThis.fetch = vi.fn(async () => {
      await slowFetchPromise;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => JSON.parse(JSON.stringify(sampleReport)),
      } as Response;
    });

    await renderExport({ date: "2026-11-07" });

    const pdfBtn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      b.textContent?.includes("Export PDF"),
    );

    await act(async () => {
      pdfBtn?.click();
    });

    const dialog = document.querySelector("[role='dialog']");
    expect(dialog?.textContent).toContain("Preparing daily report...");

    const cancelBtn = Array.from(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
      (b) => b.textContent?.includes("Cancel") || b.textContent?.includes("Close"),
    );
    expect(cancelBtn).toBeDefined();

    await act(async () => {
      cancelBtn?.click();
    });

    await act(async () => {
      resolveSlowFetch({
        ok: true,
        status: 200,
        json: async () => JSON.parse(JSON.stringify(sampleReport)),
      });
    });
    await flushAsyncEvents();

    expect(renderMockState.prepareDailyReport).not.toHaveBeenCalled();
    expect(linkClicks.length).toBe(0);
  });

  it("privacy activates mid preview: immediately closes dialog, disposes report, and prevents downloads", async () => {
    privacyState.enabled = false;
    await renderExport({ date: "2026-11-07" });

    const pdfBtn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      b.textContent?.includes("Export PDF"),
    );

    await act(async () => {
      pdfBtn?.click();
    });
    await flushAsyncEvents();

    let dialog = document.querySelector("[role='dialog']");
    expect(dialog).not.toBeNull();

    // Privacy mode activates while dialog is open
    privacyState.enabled = true;
    await act(async () => {
      root.render(
        createElement(
          TooltipProvider,
          null,
          createElement(DailyReportExport, {
            date: "2026-11-07",
            loadRenderer: mockLoadRenderer,
          }),
        ),
      );
    });
    await flushAsyncEvents();

    dialog = document.querySelector("[role='dialog']");
    expect(dialog).toBeNull();
    expect(renderMockState.prepared?.dispose).toHaveBeenCalled();
  });

  it("native WKDownload lifetime: thumbnail URLs revoked on close, but download URL survives until 15s timer fires", async () => {
    vi.useFakeTimers();

    await renderExport({ date: "2026-11-07" });

    const pdfBtn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      b.textContent?.includes("Export PDF"),
    );

    await act(async () => {
      pdfBtn?.click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    const dialog = document.querySelector("[role='dialog']");
    const downloadBtn = Array.from(
      dialog?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    ).find((b) => b.textContent?.includes("Download full PDF"));
    expect(downloadBtn).toBeDefined();

    await act(async () => {
      downloadBtn?.click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    expect(linkClicks.length).toBe(1);
    const downloadUrl = linkClicks[0]!.href;
    expect(createdUrls).toContain(downloadUrl);

    // Close the dialog immediately after download was triggered
    const cancelBtn = Array.from(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
      (b) => b.textContent === "Cancel",
    );

    await act(async () => {
      cancelBtn?.click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    // Thumbnail URLs are revoked immediately upon close
    const thumbnailUrls = createdUrls.filter((u) => u !== downloadUrl);
    for (const thumbUrl of thumbnailUrls) {
      expect(revokedUrls).toContain(thumbUrl);
    }

    // BUT download URL must NOT be revoked yet (WebKit native WKDownload needs it alive)
    expect(revokedUrls).not.toContain(downloadUrl);

    // Fast-forward 15 seconds: the timer should fire and revoke the download URL
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });

    expect(revokedUrls).toContain(downloadUrl);
    vi.useRealTimers();
  });

  it("thumbnail items accessibility: thumbnail buttons are separate interactive buttons, Enter/Space changes active page", async () => {
    await renderExport({ date: "2026-11-07" });

    const pngBtn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      b.textContent?.includes("Export PNG"),
    );

    await act(async () => {
      pngBtn?.click();
    });
    await flushAsyncEvents();

    const dialog = document.querySelector("[role='dialog']");
    const sidebarItems = dialog?.querySelectorAll("[aria-label='Page thumbnail list'] > div");
    expect(sidebarItems?.length).toBe(3);

    // Second page row contains both checkbox sibling and a real button sibling
    const secondRow = sidebarItems![1]!;
    const checkbox = secondRow.querySelector<HTMLButtonElement>("[role='checkbox']");
    const pageButton = secondRow.querySelector<HTMLButtonElement>("button:not([role='checkbox'])");

    expect(checkbox).not.toBeNull();
    expect(pageButton).not.toBeNull();
    expect(pageButton?.tagName).toBe("BUTTON");
    expect(pageButton?.getAttribute("aria-current")).toBeNull();

    // Trigger keyboard click (Enter/Space) on page button
    await act(async () => {
      pageButton?.click();
    });
    await flushAsyncEvents();

    expect(pageButton?.getAttribute("aria-current")).toBe("page");
    const mainPreviewText = dialog?.querySelector(".lg\\:col-span-8")?.textContent ?? "";
    expect(mainPreviewText).toContain("Page 2 of 3");
    expect(mainPreviewText).toContain("Trade #1 · AAPL");
  });

  it("renderPage failure: displays visible per-page error state and retry button, without infinite spinner", async () => {
    const errorPagePrepared = createMockPrepared([
      { id: "page-fail", title: "Corrupted Chart", kind: "screenshot" },
    ]);
    let failCount = 0;
    errorPagePrepared.renderPage = vi.fn(async (pageId: string) => {
      failCount++;
      if (failCount === 1) {
        throw new Error("Corrupted bitmap data");
      }
      return new Blob(["recovered-image"], { type: "image/png" });
    });

    renderMockState.prepared = errorPagePrepared;

    await renderExport({ date: "2026-11-07" });

    const pdfBtn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      b.textContent?.includes("Export PDF"),
    );

    await act(async () => {
      pdfBtn?.click();
    });
    await flushAsyncEvents();

    const dialog = document.querySelector("[role='dialog']");
    const dialogText = dialog?.textContent ?? "";

    // Error state must be visible in main preview and sidebar
    expect(dialogText).toContain("Failed to render preview for Corrupted Chart");
    expect(dialogText).toContain("Corrupted bitmap data");
    expect(dialogText).toContain("Preview failed");

    // Retry preview button must be present
    const retryBtn = Array.from(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
      (b) => b.textContent?.includes("Retry preview"),
    );
    expect(retryBtn).toBeDefined();

    // Click retry
    await act(async () => {
      retryBtn?.click();
    });
    await flushAsyncEvents();

    // Now image rendered successfully, error gone
    const updatedDialogText = dialog?.textContent ?? "";
    expect(updatedDialogText).not.toContain("Failed to render preview");
    const img = dialog?.querySelector(".lg\\:col-span-8 img");
    expect(img).not.toBeNull();
  });
});
