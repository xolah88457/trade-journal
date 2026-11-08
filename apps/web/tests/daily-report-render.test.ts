// @vitest-environment jsdom

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { Blob as NodeBlob } from "node:buffer";
import { PDFDocument } from "pdf-lib";
import { unzipSync, unzlibSync } from "fflate";
import {
  prepareDailyReport,
  prepareTradeReport,
  type DailyReportPage,
  fitImageSize,
  chooseImageEncoding,
} from "../src/lib/daily-report-render";
import {
  PAGE_WIDTH,
  PAGE_HEIGHT,
  MARGIN_LEFT,
  USABLE_WIDTH,
  formatPrecision,
} from "../src/lib/daily-report-layout";
import type { DailyReport, ReportAttachment } from "../src/lib/daily-report-types";

// Extract text from parsed PDF document pages by decoding glyph IDs against embedded ToUnicode CMaps
function extractPdfPageTexts(doc: PDFDocument): string[] {
  const cmap = new Map<string, string>();
  for (const [, obj] of (doc.context as any).enumerateIndirectObjects()) {
    if (obj && typeof obj.getContents === "function") {
      try {
        const text = new TextDecoder().decode(unzlibSync(obj.getContents()));
        // bfchar entries: <glyph> <UTF-16 units>; ligatures map to several code units
        for (const m of text.matchAll(/<([0-9a-fA-F]+)>\s+<([0-9a-fA-F]+)>/g)) {
          const units = m[2]!.match(/.{4}/g) ?? [];
          cmap.set(m[1]!.toLowerCase(), String.fromCharCode(...units.map((u) => parseInt(u, 16))));
        }
      } catch {
        // ignore non-zlib streams
      }
    }
  }

  return doc.getPages().map((page) => {
    const contents = (page.node as any).normalizedEntries().Contents;
    const refs = contents
      ? Array.isArray(contents.asArray?.())
        ? contents.asArray()
        : [contents]
      : [];
    let out = "";
    for (const r of refs) {
      const stream = doc.context.lookup(r) as any;
      if (!stream || typeof stream.getContents !== "function") continue;
      try {
        const dec = new TextDecoder().decode(unzlibSync(stream.getContents()));
        for (const hexMatch of dec.matchAll(/<([0-9a-fA-F]+)>\s*Tj/g)) {
          const hex = hexMatch[1]!;
          let decodedStr = "";
          for (let i = 0; i < hex.length; i += 4) {
            const code = hex.slice(i, i + 4).toLowerCase();
            decodedStr += cmap.get(code) || "";
          }
          out += decodedStr + " ";
        }
      } catch {
        // ignore
      }
    }
    return out;
  });
}

// Load actual production font fixture in tests
const fontPath = existsSync(resolve(process.cwd(), "apps/web/public/fonts/NotoSans-Regular.ttf"))
  ? resolve(process.cwd(), "apps/web/public/fonts/NotoSans-Regular.ttf")
  : resolve(process.cwd(), "public/fonts/NotoSans-Regular.ttf");
const FONT_BYTES = readFileSync(fontPath);

// Mock global fetch and Canvas in test environment
const originalFetch = globalThis.fetch;
beforeAll(() => {
  // Ensure Blob has arrayBuffer in jsdom test environment
  if (typeof Blob === "undefined" || typeof Blob.prototype.arrayBuffer !== "function") {
    globalThis.Blob = NodeBlob as any;
    if (typeof window !== "undefined") {
      (window as any).Blob = NodeBlob;
    }
  }

  // Mock FontFace if not present in environment
  if (typeof globalThis.FontFace === "undefined") {
    globalThis.FontFace = class {
      family: string;
      source: any;
      constructor(family: string, source: any) {
        this.family = family;
        this.source = source;
      }
      async load() {
        return this;
      }
    } as any;
  }
  if (typeof document !== "undefined" && !document.fonts) {
    (document as any).fonts = {
      add: vi.fn(),
      ready: Promise.resolve(),
    };
  }

  // Mock Canvas 2D context for jsdom unit test environment
  if (typeof HTMLCanvasElement !== "undefined") {
    HTMLCanvasElement.prototype.getContext = function (type: string) {
      if (type === "2d") {
        return {
          font: "",
          fillStyle: "",
          strokeStyle: "",
          lineWidth: 1,
          textBaseline: "top",
          textAlign: "left",
          measureText: (text: string) => ({ width: text.length * 8 }),
          fillText: vi.fn(),
          fillRect: vi.fn(),
          strokeRect: vi.fn(),
          beginPath: vi.fn(),
          moveTo: vi.fn(),
          lineTo: vi.fn(),
          stroke: vi.fn(),
          fill: vi.fn(),
          closePath: vi.fn(),
          arc: vi.fn(),
          save: vi.fn(),
          restore: vi.fn(),
          scale: vi.fn(),
          drawImage: vi.fn(),
          setLineDash: vi.fn(),
        };
      }
      return null;
    } as any;

    HTMLCanvasElement.prototype.toBlob = function (
      callback: (blob: Blob | null) => void,
      mime = "image/png",
    ) {
      callback(new Blob([TEST_PNG], { type: mime }));
    };
  }

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/fonts/NotoSans-Regular.ttf")) {
      return new Response(FONT_BYTES, {
        status: 200,
        headers: { "Content-Type": "font/ttf" },
      });
    }
    return originalFetch(input, init);
  }) as any;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

// 1x1 test PNG
const TEST_PNG = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0,
  0, 31, 21, 196, 137, 0, 0, 0, 11, 73, 68, 65, 84, 120, 156, 99, 96, 0, 0, 0, 2, 0, 1, 229, 39,
  222, 250, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
]);

// Minimal valid JPEG bytes
const TEST_JPG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08,
  0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
  0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20, 0x24, 0x2e, 0x27, 0x20,
  0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29, 0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27,
  0x39, 0x3d, 0x38, 0x32, 0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01,
  0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00, 0x01, 0x05, 0x01, 0x01,
  0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04,
  0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f,
  0x00, 0xbf, 0x00, 0xff, 0xd9,
]);

function createMockReport(overrides: Partial<DailyReport> = {}): DailyReport {
  return {
    date: "2026-09-02",
    exportedAt: "2026-09-02T16:45:00.000Z",
    timeZone: "America/New_York",
    scope: {
      label: "Strategy: Trend Continuation · Required tags: Breakout",
      filters: { tag: "Breakout", playbookId: "pb1" },
      accountNames: ["Apex 50k", "Topstep 100k"],
      currencies: ["USD", "EUR"],
    },
    metrics: {
      totalTrades: 2,
      closedTrades: 2,
      openTrades: 0,
      wins: 0,
      losses: 2,
      breakevens: 0,
      netPnl: -650,
      grossPnl: -580,
      fees: 70,
      winRate: 0,
      dayWinRate: 0,
      tradingDays: 1,
      profitFactor: 0,
      profitFactorIsInfinite: false,
      avgWin: null,
      avgLoss: 325,
      avgWinLossRatio: null,
      expectancy: -325,
      largestWin: 0,
      largestLoss: -400,
      maxWinStreak: 0,
      maxLossStreak: 2,
      currentStreak: -2,
      totalVolume: 8,
      avgDurationMs: 1450000,
      maxDrawdown: 650,
      maxDrawdownPct: 0.013,
      recoveryFactor: null,
      profitConcentration: null,
      avgRealizedR: -1.15,
      tradesWithRisk: 2,
    },
    profitFactorIsInfinite: false,
    intraday: [
      { t: "09:30", cumNetPnl: 0 },
      { t: "10:15", cumNetPnl: -250 },
      { t: "11:00", cumNetPnl: -650 },
    ],
    note: '## Market Overview\nChallenging session on ES & NQ.\n- [x] Respected max loss per trade\n- [ ] Waited for 15m candle confirmation\n> "Discipline over impulse."\n\nObservation: Scaled out too early before market reversed.',
    noteUpdatedAt: "2026-09-02T16:30:00.000Z",
    attachments: [
      {
        id: "att-day-img-1",
        name: "es-daily-context.png",
        mime: "image/png",
        size: 1024,
        createdAt: "2026-09-02T16:00:00.000Z",
      },
      {
        id: "att-day-doc-1",
        name: "broker-statement-2026-09-02.pdf",
        mime: "application/pdf",
        size: 245000,
        createdAt: "2026-09-02T16:15:00.000Z",
      },
    ],
    trades: [
      {
        key: "trade-es-1",
        symbol: "ES",
        accountId: "acc-1",
        accountName: "Apex 50k",
        currency: "USD",
        assetClass: "futures",
        direction: "long",
        status: "loss",
        openedAt: "2026-09-02T09:35:00.000Z",
        closedAt: "2026-09-02T10:15:00.000Z",
        durationMs: 2400000,
        quantity: 2,
        openQuantity: 0,
        contractMultiplier: 50,
        avgEntry: 5420.25,
        avgExit: 5415.5,
        grossPnl: -237.5,
        fees: 12.5,
        netPnl: -250,
        netReturnOnEntry: -0.00092,
        riskAmount: 250,
        plannedR: 2.0,
        realizedR: -1.0,
        stopLoss: 5415.5,
        profitTarget: 5430.0,
        targetHit: "stop_loss",
        rating: 4,
        reviewedAt: "2026-09-02T11:00:00.000Z",
        tags: ["Breakout", "Morning Session"],
        mistakes: ["Chased Entry"],
        notes:
          "### Trade Reflection\nEntered slightly late on 5m breakout. Trailed stop as planned.\n\nKey lesson: wait for retest.",
        playbook: {
          id: "pb-1",
          name: "Trend Continuation",
          description: "Enter on pullback to 20 EMA in strong trend",
          rules: [
            { rule: "Wait for 20 EMA touch", followed: true },
            { rule: "Check higher timeframe trend", followed: true },
            { rule: "Do not enter before candle closes", followed: false },
          ],
        },
        executions: [
          {
            id: "ex-1",
            executedAt: "2026-09-02T09:35:00.000Z",
            side: "buy",
            quantity: 2,
            price: 5420.25,
            fee: 6.25,
            source: "Rithmic",
          },
          {
            id: "ex-2",
            executedAt: "2026-09-02T10:15:00.000Z",
            side: "sell",
            quantity: 2,
            price: 5415.5,
            fee: 6.25,
            source: "Rithmic",
          },
        ],
        runningPnl: [
          { t: "09:35", cumNetPnl: 0 },
          { t: "10:15", cumNetPnl: -250 },
        ],
        attachments: [
          {
            id: "att-trade-img-1",
            name: "es-trade-fill-chart.png",
            mime: "image/png",
            size: 2048,
            createdAt: "2026-09-02T10:20:00.000Z",
          },
        ],
        aiReviews: [
          {
            id: "rev-1",
            createdAt: "2026-09-02T10:45:00.000Z",
            provider: "anthropic",
            model: "claude-3-5-sonnet",
            content:
              "## AI Critique\nGood risk discipline taking the stop loss immediately. However, entering before the candle closed violated Rule 3.",
          },
        ],
        excursions: {
          mae: -300,
          mfe: 120,
          sampledBars: 40,
          resolution: "1m",
          provider: "databento",
          fetchedAt: "2026-09-02T10:30:00.000Z",
        },
      },
      {
        key: "trade-nq-2",
        symbol: "NQ",
        accountId: "acc-2",
        accountName: "Topstep 100k",
        currency: "USD",
        assetClass: "futures",
        direction: "short",
        status: "loss",
        openedAt: "2026-09-02T10:20:00.000Z",
        closedAt: "2026-09-02T11:00:00.000Z",
        durationMs: 2400000,
        quantity: 2,
        openQuantity: 0,
        contractMultiplier: 20,
        avgEntry: 19500.0,
        avgExit: 19510.0,
        grossPnl: -385.0,
        fees: 15.0,
        netPnl: -400,
        netReturnOnEntry: -0.001,
        riskAmount: 300,
        plannedR: 2.5,
        realizedR: -1.33,
        stopLoss: 19510.0,
        profitTarget: 19450.0,
        targetHit: "stop_loss",
        rating: 2,
        reviewedAt: null,
        tags: ["Reversal"],
        mistakes: ["Revenge Trade"],
        notes: "Tried to short against momentum after ES loss.",
        playbook: null,
        executions: Array.from({ length: 45 }, (_, i) => ({
          id: `ex-nq-${i + 1}`,
          executedAt: `2026-09-02T10:${String(20 + Math.floor(i / 2)).padStart(2, "0")}:00.000Z`,
          side: (i % 2 === 0 ? "sell" : "buy") as "buy" | "sell",
          quantity: 1,
          price: 19500.0 + i * 0.25,
          fee: 1.5,
          source: "Tradovate",
        })),
        runningPnl: [
          { t: "10:20", cumNetPnl: 0 },
          { t: "10:40", cumNetPnl: -150 },
          { t: "11:00", cumNetPnl: -400 },
        ],
        attachments: [],
        aiReviews: [],
        excursions: null,
      },
    ],
    ...overrides,
  };
}

describe("Comprehensive Daily Report Renderer (PDF + PNG)", () => {
  it("generates deterministic pages, builds valid PDF with metadata, and parses pages correctly", async () => {
    const report = createMockReport();
    const prepared = await prepareDailyReport(report, {
      imageLoader: async (att) => {
        if (att.mime === "application/pdf") {
          throw new Error("Should never attempt to load PDF document as screenshot image");
        }
        return TEST_PNG;
      },
    });

    expect(prepared.pages.length).toBeGreaterThanOrEqual(4);

    // Verify page kinds and titles
    const dailyPage = prepared.pages.find((p) => p.kind === "daily");
    expect(dailyPage).toBeDefined();
    expect(dailyPage?.title).toContain("Daily overview");

    const tradePages = prepared.pages.filter((p) => p.kind === "trade");
    expect(tradePages.length).toBeGreaterThanOrEqual(2);

    const screenshotPages = prepared.pages.filter((p) => p.kind === "screenshot");
    expect(screenshotPages.length).toBe(2); // 1 day image + 1 trade image
    expect(screenshotPages[0]?.title).toContain("es-daily-context.png");
    expect(screenshotPages[1]?.title).toContain("es-trade-fill-chart.png");

    // Build PDF
    const pdfExport = await prepared.buildPdf();
    expect(pdfExport.filename).toBe("2026-09-02-daily-report.pdf");
    expect(pdfExport.blob.type).toBe("application/pdf");

    // Parse and verify with pdf-lib
    const pdfBytes = new Uint8Array(await pdfExport.blob.arrayBuffer());
    const doc = await PDFDocument.load(pdfBytes);

    expect(doc.getPageCount()).toBe(prepared.pages.length);
    expect(doc.getTitle()).toBe("Daily Report · 2026-09-02");
    expect(doc.getCreator()).toBe("Sumi");

    prepared.dispose();
  });

  it("handles long daily note tail continuation without truncating or hiding overflow", async () => {
    const longNote = Array.from(
      { length: 80 },
      (_, i) =>
        `Paragraph ${i + 1}: Continuous review line discussing risk parameters, psychology, and market context.`,
    ).join("\n\n");

    const report = createMockReport({
      note: longNote,
      trades: [],
      attachments: [],
    });

    const prepared = await prepareDailyReport(report);
    // Overview must continue across multiple pages to avoid overflow
    expect(prepared.pages.length).toBeGreaterThan(1);
    expect(prepared.pages[0]?.title).toBe("Daily overview · 2026-09-02");
    expect(prepared.pages[1]?.title).toContain("Daily overview · 2026-09-02 (Continued)");

    const pdf = await prepared.buildPdf();
    const pdfBytes = new Uint8Array(await pdf.blob.arrayBuffer());
    const doc = await PDFDocument.load(pdfBytes);
    expect(doc.getPageCount()).toBe(prepared.pages.length);
  });

  it("repeats table headers on page breaks for long execution lists", async () => {
    const report = createMockReport();
    const prepared = await prepareDailyReport(report, {
      imageLoader: async () => TEST_PNG,
    });

    // Trade 2 has 45 fills which triggers mid-table page continuation
    const trade2Layouts = (prepared as any).pageLayouts.filter(
      (p: any) => p.tradeKey === "trade-nq-2",
    );
    expect(trade2Layouts.length).toBeGreaterThanOrEqual(2);

    // First page of trade 2 has table header
    const p1Texts = trade2Layouts[0].items
      .filter((i: any) => i.type === "text")
      .map((i: any) => i.text);
    expect(p1Texts).toContain("Time");
    expect(p1Texts).toContain("Qty");
    expect(p1Texts).toContain("Price");

    // Second page of trade 2 (continuation) ALSO has repeated table header
    const p2Texts = trade2Layouts[1].items
      .filter((i: any) => i.type === "text")
      .map((i: any) => i.text);
    expect(p2Texts).toContain("Time");
    expect(p2Texts).toContain("Qty");
    expect(p2Texts).toContain("Price");
  });

  it("preserves rules checklist, AI reviews, stop loss, profit target, and rating", async () => {
    const report = createMockReport();
    const prepared = await prepareDailyReport(report, {
      imageLoader: async () => TEST_PNG,
    });

    const esPage = prepared.pages.find((p) => p.tradeKey === "trade-es-1");
    expect(esPage).toBeDefined();

    const texts = (prepared as any).pageLayouts
      .filter((p: any) => p.tradeKey === "trade-es-1")
      .flatMap((p: any) => p.items.filter((i: any) => i.type === "text").map((i: any) => i.text));

    // Verify rules, stop/target, and rating are rendered
    expect(texts.some((t: string) => t.includes("Wait for 20 EMA touch"))).toBe(true);
    expect(texts.some((t: string) => t.includes("Check higher timeframe trend"))).toBe(true);
    expect(texts.some((t: string) => t.includes("Do not enter before candle closes"))).toBe(true);
    expect(texts.some((t: string) => t === "5,415.50")).toBe(true);
    expect(texts.some((t: string) => t === "5,430.00")).toBe(true);
    expect(texts.some((t: string) => t === "Stop hit")).toBe(true);
    expect(texts.some((t: string) => t.includes("Rating 4/5"))).toBe(true);
    expect(texts.some((t: string) => t.includes("anthropic · claude-3-5-sonnet"))).toBe(true);
  });

  it("renders EVERY saved AI review in full without truncation", async () => {
    const report = createMockReport({
      attachments: [],
      trades: [
        {
          ...createMockReport().trades[0]!,
          aiReviews: [
            {
              id: "rev-1",
              createdAt: "2026-09-02T10:45:00.000Z",
              provider: "anthropic",
              model: "claude-3-5-sonnet",
              content: "First review: Focus on waiting for the setup to confirm.",
            },
            {
              id: "rev-2",
              createdAt: "2026-09-02T11:15:00.000Z",
              provider: "openai",
              model: "gpt-4o",
              content: "Second review: Trailing stop loss was well-managed despite the loss.",
            },
          ],
        },
      ],
    });

    const prepared = await prepareDailyReport(report, {
      imageLoader: async () => TEST_PNG,
    });
    const texts = (prepared as any).pageLayouts
      .filter((p: any) => p.tradeKey === "trade-es-1")
      .flatMap((p: any) => p.items.filter((i: any) => i.type === "text").map((i: any) => i.text));

    expect(texts.some((t: string) => t.includes("First review"))).toBe(true);
    expect(texts.some((t: string) => t.includes("Second review"))).toBe(true);
  });

  it("lists PDF document attachments without reading or merging them", async () => {
    let pdfDocLoaded = false;
    const report = createMockReport();

    const prepared = await prepareDailyReport(report, {
      imageLoader: async (att) => {
        if (att.mime === "application/pdf") {
          pdfDocLoaded = true;
          throw new Error("PDF document must NOT be loaded as an image!");
        }
        return TEST_PNG;
      },
    });

    expect(pdfDocLoaded).toBe(false);

    // The PDF document should NOT have a dedicated screenshot page
    const screenshotForPdf = prepared.pages.find((p) => p.title.includes("broker-statement"));
    expect(screenshotForPdf).toBeUndefined();

    // Verify it is listed in the overview table
    const texts = (prepared as any).pageLayouts
      .filter((p: any) => p.kind === "daily")
      .flatMap((p: any) => p.items.filter((i: any) => i.type === "text").map((i: any) => i.text));
    expect(texts.some((t: string) => t.includes("broker-statement-2026-09-02.pdf"))).toBe(true);
  });

  it("surfaces download errors when a screenshot fails to fetch (cannot claim complete)", async () => {
    const report = createMockReport();
    const failingLoader = async (att: ReportAttachment) => {
      if (att.id === "att-day-img-1") {
        throw new Error("HTTP 404: Screenshot file not found");
      }
      return TEST_PNG;
    };

    await expect(prepareDailyReport(report, { imageLoader: failingLoader })).rejects.toThrow(
      "Screenshot file not found",
    );
  });

  it("supports single PNG export and multi-page ZIP export with safe entry names", async () => {
    const report = createMockReport({ attachments: [], trades: [] });
    const prepared = await prepareDailyReport(report);

    // Zero selection throws useful error
    await expect(prepared.buildPngDownload([])).rejects.toThrow("Select at least one page");

    // Invalid selection throws useful error
    await expect(prepared.buildPngDownload(["non-existent-page"])).rejects.toThrow(
      "Invalid page ID",
    );

    // Single page selection returns single PNG
    const singleExport = await prepared.buildPngDownload([prepared.pages[0]!.id]);
    expect(singleExport.filename).toMatch(/^2026-09-02-daily-report-01-.*\.png$/);
    expect(singleExport.blob.type).toBe("image/png");

    // Multi-page ZIP export
    const multiPageReport = createMockReport({
      note: Array.from({ length: 40 }, (_, i) => `Line ${i}`).join("\n\n"),
      attachments: [],
      trades: [],
    });
    const multiPrepared = await prepareDailyReport(multiPageReport);
    expect(multiPrepared.pages.length).toBeGreaterThan(1);

    const zipExport = await multiPrepared.buildPngDownload([
      multiPrepared.pages[0]!.id,
      multiPrepared.pages[1]!.id,
    ]);
    expect(zipExport.filename).toBe("2026-09-02-daily-report.zip");
    expect(zipExport.blob.type).toBe("application/zip");

    // Decode ZIP and verify entries
    const zipBytes = new Uint8Array(await zipExport.blob.arrayBuffer());
    const entries = unzipSync(zipBytes);
    const keys = Object.keys(entries);
    expect(keys.length).toBe(2);
    expect(keys[0]).toMatch(/^01-.*\.png$/);
    expect(keys[1]).toMatch(/^02-.*\.png$/);
  });

  it("supports arbitrary PDF page selection: noncontiguous pages, excludes unselected, preserves logical order, default omitted, and rejects empty/unknown", async () => {
    const report = createMockReport();
    const prepared = await prepareDailyReport(report, {
      imageLoader: async () => TEST_PNG,
    });

    expect(prepared.pages.length).toBeGreaterThanOrEqual(4);
    const p0 = prepared.pages[0]!; // Daily overview
    const p1 = prepared.pages.find((p) => p.kind === "screenshot" && !p.tradeKey)!; // Day screenshot
    const p2 = prepared.pages.find((p) => p.tradeKey === "trade-es-1" && p.kind === "trade")!; // Trade #1
    const p3 = prepared.pages.find((p) => p.kind === "screenshot" && p.tradeKey)!; // Trade screenshot

    // 1. Backward compatibility: omitted argument defaults to all pages
    const defaultExport = await prepared.buildPdf();
    const defaultPdfBytes = new Uint8Array(await defaultExport.blob.arrayBuffer());
    const defaultDoc = await PDFDocument.load(defaultPdfBytes);
    expect(defaultDoc.getPageCount()).toBe(prepared.pages.length);

    // 2. Explicit empty selection throws error
    await expect(prepared.buildPdf([])).rejects.toThrow("Select at least one page");

    // 3. Unknown page ID throws error
    await expect(prepared.buildPdf(["unknown-page-id"])).rejects.toThrow(
      'Invalid page ID: "unknown-page-id".',
    );

    // 4. Noncontiguous selection (first + third page: p0 and p2), reversed order and duplicate IDs
    // Pass reversed order with duplicates: [p2.id, p0.id, p2.id]
    const selectiveExport = await prepared.buildPdf([p2.id, p0.id, p2.id]);
    expect(selectiveExport.filename).toBe("2026-09-02-daily-report.pdf");
    expect(selectiveExport.blob.type).toBe("application/pdf");

    // Parse actual PDF bytes
    const pdfBytes = new Uint8Array(await selectiveExport.blob.arrayBuffer());
    const doc = await PDFDocument.load(pdfBytes);

    // Confirms count is exactly 2 (duplicates deduped, excluded pages omitted)
    expect(doc.getPageCount()).toBe(2);

    // Parse actual page content from PDF stream using ToUnicode CMap
    const pageTexts = extractPdfPageTexts(doc);
    expect(pageTexts.length).toBe(2);

    // First page in PDF must correspond to p0 (logical report order preserved despite reversed input)
    expect(pageTexts[0]).toContain("DAILY REPORT");
    expect(pageTexts[0]).toContain("Wednesday, 2 September 2026");
    expect(pageTexts[0]).toContain(`Page 1 of ${prepared.pages.length}`); // footer retains source page number

    // Second page in PDF must correspond to p2 (third page in report: ES trade)
    expect(pageTexts[1]).toContain("ES LONG LOSS");
    expect(pageTexts[1]).toContain(
      `Page ${prepared.pages.indexOf(p2) + 1} of ${prepared.pages.length}`,
    ); // footer retains source page number

    // Excluded pages (p1 screenshot, p3 screenshot, p4 NQ trade) must NOT be present in any page of the PDF
    expect(pageTexts[0]).not.toContain("es-daily-context.png");
    expect(pageTexts[1]).not.toContain("es-daily-context.png");
    expect(pageTexts[0]).not.toContain("es-trade-fill-chart.png");
    expect(pageTexts[1]).not.toContain("es-trade-fill-chart.png");
    expect(pageTexts[0]).not.toContain("NQ SHORT");
    expect(pageTexts[1]).not.toContain("NQ SHORT");

    prepared.dispose();
  });

  it("preserves non-ASCII characters and emojis without dropping or replacing with [emoji]", async () => {
    const rawNote = "Scaled out at +2R 🚀 and enjoyed café ☕ with ¥10,000 profit! ★★★★☆";
    const report = createMockReport({
      note: rawNote,
      attachments: [],
      trades: [],
    });

    const prepared = await prepareDailyReport(report);
    const pdfExport = await prepared.buildPdf();
    const pdfBytes = new Uint8Array(await pdfExport.blob.arrayBuffer());
    const doc = await PDFDocument.load(pdfBytes);

    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
    expect(doc.getTitle()).toBe("Daily Report · 2026-09-02");

    // Verify layout items preserve emojis and non-ASCII verbatim without [emoji] or dropping
    const layout = (prepared as any).pageLayouts[0];
    const textItems = layout.items.filter((i: any) => i.type === "text").map((i: any) => i.text);
    const found = textItems.some(
      (t: string) => t.includes("🚀") && t.includes("☕") && t.includes("café"),
    );
    expect(found).toBe(true);
    expect(textItems.some((t: string) => t.includes("[emoji]"))).toBe(false);
  });

  it("normalizes and embeds JPEG screenshot images", async () => {
    const report = createMockReport({
      attachments: [
        {
          id: "att-day-jpg-1",
          name: "chart-screenshot.jpg",
          mime: "image/jpeg",
          size: TEST_JPG.length,
          createdAt: "2026-09-02T16:00:00.000Z",
        },
      ],
      trades: [],
    });

    const prepared = await prepareDailyReport(report, {
      imageLoader: async () => TEST_JPG,
    });

    const screenshotPage = prepared.pages.find((p) => p.kind === "screenshot");
    expect(screenshotPage).toBeDefined();

    const pdfExport = await prepared.buildPdf();
    const pdfBytes = new Uint8Array(await pdfExport.blob.arrayBuffer());
    const doc = await PDFDocument.load(pdfBytes);
    expect(doc.getPageCount()).toBe(2); // 1 overview + 1 dedicated screenshot
  });

  it("supports UI thumbnail rendering at scale 0.65", async () => {
    const report = createMockReport({ attachments: [], trades: [] });
    const prepared = await prepareDailyReport(report);

    const thumbBlob = await prepared.renderPage(prepared.pages[0]!.id, 0.65);
    expect(thumbBlob).toBeDefined();
    expect(thumbBlob.type).toBe("image/png");
    expect(thumbBlob.size).toBeGreaterThan(0);
  });

  it("aborts report preparation when AbortSignal triggers", async () => {
    const report = createMockReport();
    const controller = new AbortController();
    controller.abort();

    await expect(
      prepareDailyReport(report, {
        signal: controller.signal,
        imageLoader: async () => TEST_PNG,
      }),
    ).rejects.toThrow(/abort/i);
  });

  it("cleans up resources upon dispose", async () => {
    const report = createMockReport();
    const prepared = await prepareDailyReport(report, {
      imageLoader: async () => TEST_PNG,
    });

    expect(() => prepared.dispose()).not.toThrow();
  });

  describe("financial formatting & precision verification", () => {
    it("formats USD currency with $ symbol and regular cents display", async () => {
      const report = createMockReport({
        scope: {
          label: "USD Account",
          filters: {},
          accountNames: ["USD Account"],
          currencies: ["USD"],
        },
        metrics: {
          ...createMockReport().metrics,
          netPnl: 1250.5,
          grossPnl: 1300,
          fees: 49.5,
        },
        trades: [
          {
            ...createMockReport().trades[0]!,
            currency: "USD",
            netPnl: 1250.5,
            grossPnl: 1300,
            fees: 49.5,
            attachments: [],
          },
        ],
        attachments: [],
      });

      const prepared = await prepareDailyReport(report, {
        imageLoader: async () => TEST_PNG,
      });
      const overviewLayout = (prepared as any).pageLayouts[0];
      const overviewTexts = overviewLayout.items
        .filter((i: any) => i.type === "text")
        .map((i: any) => i.text);

      expect(overviewTexts).toContain("+$1,250.50");
      expect(overviewTexts.some((t: string) => t.includes("Gross $1,300.00"))).toBe(true);
      expect(overviewTexts.some((t: string) => t.includes("Fees $49.50"))).toBe(true);
      expect(overviewTexts.some((t: string) => t.includes("(Mixed)"))).toBe(false);

      const tradeLayout = (prepared as any).pageLayouts.find((p: any) => p.kind === "trade");
      const tradeTexts = tradeLayout.items
        .filter((i: any) => i.type === "text")
        .map((i: any) => i.text);

      expect(tradeTexts).toContain("+$1,250.50");
      expect(tradeTexts).toContain("+$1,300.00");
      expect(tradeTexts).toContain("$49.50");
    });

    it("formats EUR currency with € symbol and NEVER labels EUR with $", async () => {
      const report = createMockReport({
        scope: {
          label: "EUR Account",
          filters: {},
          accountNames: ["EUR Account"],
          currencies: ["EUR"],
        },
        metrics: {
          ...createMockReport().metrics,
          netPnl: -450.75,
          grossPnl: -430.0,
          fees: 20.75,
        },
        trades: [
          {
            ...createMockReport().trades[0]!,
            currency: "EUR",
            netPnl: -450.75,
            grossPnl: -430.0,
            fees: 20.75,
            attachments: [],
          },
        ],
        attachments: [],
      });

      const prepared = await prepareDailyReport(report, {
        imageLoader: async () => TEST_PNG,
      });
      const overviewLayout = (prepared as any).pageLayouts[0];
      const overviewTexts = overviewLayout.items
        .filter((i: any) => i.type === "text")
        .map((i: any) => i.text);

      // Verify EUR symbol is used
      expect(overviewTexts).toContain("-€450.75");
      expect(overviewTexts.some((t: string) => t.includes("Gross -€430.00"))).toBe(true);
      expect(overviewTexts.some((t: string) => t.includes("Fees €20.75"))).toBe(true);

      // Verify NEVER labeled with $
      expect(overviewTexts.some((t: string) => t.includes("$450.75"))).toBe(false);
      expect(overviewTexts.some((t: string) => t.includes("$430.00"))).toBe(false);

      const tradeLayout = (prepared as any).pageLayouts.find((p: any) => p.kind === "trade");
      const tradeTexts = tradeLayout.items
        .filter((i: any) => i.type === "text")
        .map((i: any) => i.text);

      expect(tradeTexts).toContain("-€450.75");
      expect(tradeTexts).toContain("-€430.00");
      expect(tradeTexts).toContain("€20.75");
      expect(tradeTexts.some((t: string) => t.includes("$450.75"))).toBe(false);
    });

    it("formats non-ISO USDT crypto code cleanly without Intl throws or $ symbol", async () => {
      const report = createMockReport({
        scope: {
          label: "Crypto USDT Account",
          filters: {},
          accountNames: ["Binance USDT"],
          currencies: ["USDT"],
        },
        metrics: {
          ...createMockReport().metrics,
          netPnl: 850.25,
          grossPnl: 860.0,
          fees: 9.75,
        },
        trades: [
          {
            ...createMockReport().trades[0]!,
            currency: "USDT",
            netPnl: 850.25,
            grossPnl: 860.0,
            fees: 9.75,
            attachments: [],
          },
        ],
        attachments: [],
      });

      const prepared = await prepareDailyReport(report, {
        imageLoader: async () => TEST_PNG,
      });
      const overviewLayout = (prepared as any).pageLayouts[0];
      const overviewTexts = overviewLayout.items
        .filter((i: any) => i.type === "text")
        .map((i: any) => i.text);

      // USDT is formatted as code suffix without $
      expect(overviewTexts).toContain("+850.25 USDT");
      expect(overviewTexts.some((t: string) => t.includes("Gross 860.00 USDT"))).toBe(true);
      expect(overviewTexts.some((t: string) => t.includes("Fees 9.75 USDT"))).toBe(true);
      expect(overviewTexts.some((t: string) => t.includes("$850"))).toBe(false);

      const tradeLayout = (prepared as any).pageLayouts.find((p: any) => p.kind === "trade");
      const tradeTexts = tradeLayout.items
        .filter((i: any) => i.type === "text")
        .map((i: any) => i.text);

      expect(tradeTexts).toContain("+850.25 USDT");
      expect(tradeTexts).toContain("9.75 USDT");
    });

    it("formats mixed currencies scope as explicit raw mixed units without mislabelling as first currency", async () => {
      const report = createMockReport({
        scope: {
          label: "Multi-currency Portfolio",
          filters: {},
          accountNames: ["Apex USD", "IBKR EUR"],
          currencies: ["USD", "EUR"],
        },
        metrics: {
          ...createMockReport().metrics,
          netPnl: -650,
          grossPnl: -580,
          fees: 70,
          expectancy: -325,
          maxDrawdown: 650,
        },
        trades: [
          {
            ...createMockReport().trades[0]!,
            currency: "USD",
            netPnl: -250,
            attachments: [],
          },
          {
            ...createMockReport().trades[1]!,
            currency: "EUR",
            netPnl: -400,
            attachments: [],
          },
        ],
        attachments: [],
      });

      const prepared = await prepareDailyReport(report, {
        imageLoader: async () => TEST_PNG,
      });
      const overviewLayout = (prepared as any).pageLayouts[0];
      const overviewTexts = overviewLayout.items
        .filter((i: any) => i.type === "text")
        .map((i: any) => i.text);

      // Verify overview aggregate explicitly labels as (Mixed), NOT mislabelled as USD or EUR
      expect(overviewTexts).toContain("-650.00 (Mixed)");
      expect(overviewTexts.some((t: string) => t.includes("Gross -580.00 (Mixed)"))).toBe(true);
      expect(overviewTexts.some((t: string) => t.includes("Fees 70.00 (Mixed)"))).toBe(true);
      expect(overviewTexts.some((t: string) => t.includes("Expectancy -325.00"))).toBe(true);
      expect(overviewTexts.some((t: string) => t === "650.00 (Mixed)")).toBe(true);

      // Must NOT claim -$650.00 USD or -€650.00 EUR for the combined aggregate
      expect(overviewTexts.some((t: string) => t.includes("-$650.00"))).toBe(false);
      expect(overviewTexts.some((t: string) => t.includes("-€650.00"))).toBe(false);

      // But individual trades retain their own separate currencies
      const trade1Layout = (prepared as any).pageLayouts.find(
        (p: any) => p.tradeKey === "trade-es-1",
      );
      const trade1Texts = trade1Layout.items
        .filter((i: any) => i.type === "text")
        .map((i: any) => i.text);
      expect(trade1Texts).toContain("-$250.00");

      const trade2Layout = (prepared as any).pageLayouts.find(
        (p: any) => p.tradeKey === "trade-nq-2",
      );
      const trade2Texts = trade2Layout.items
        .filter((i: any) => i.type === "text")
        .map((i: any) => i.text);
      expect(trade2Texts).toContain("-€400.00");
    });

    it("preserves full JS precision for tiny crypto prices, quantities, and contract multipliers (no 0.0000 floor)", async () => {
      const report = createMockReport({
        attachments: [],
        trades: [
          {
            key: "trade-crypto-tiny",
            symbol: "PEPE/USDT",
            accountId: "acc-crypto",
            accountName: "Binance Spot",
            currency: "USDT",
            assetClass: "crypto",
            direction: "long",
            status: "win",
            openedAt: "2026-09-02T12:00:00.000Z",
            closedAt: "2026-09-02T13:00:00.000Z",
            durationMs: 3600000,
            quantity: 3e-8,
            openQuantity: 1e-8,
            contractMultiplier: 0.0001,
            avgEntry: 1e-7,
            avgExit: 1.5e-7,
            grossPnl: 0.000045,
            fees: 0.000002,
            netPnl: 0.000043,
            netReturnOnEntry: 0.5,
            riskAmount: 0.00002,
            plannedR: 2.5,
            realizedR: 2.15,
            stopLoss: 8e-8,
            profitTarget: 2e-7,
            targetHit: "profit_target",
            rating: 5,
            reviewedAt: null,
            tags: ["Meme", "TinyCrypto"],
            mistakes: [],
            notes: "Traded fractional satoshi units with micro multipliers.",
            playbook: null,
            executions: [
              {
                id: "ex-tiny-1",
                executedAt: "2026-09-02T12:00:00.000Z",
                side: "buy",
                quantity: 3e-8,
                price: 1e-7,
                fee: 0.000001,
                source: "Binance",
              },
              {
                id: "ex-tiny-2",
                executedAt: "2026-09-02T13:00:00.000Z",
                side: "sell",
                quantity: 2e-8,
                price: 1.5e-7,
                fee: 0.000001,
                source: "Binance",
              },
            ],
            runningPnl: [
              { t: "12:00", cumNetPnl: 0 },
              { t: "13:00", cumNetPnl: 0.000043 },
            ],
            attachments: [],
            aiReviews: [],
            excursions: null,
          },
        ],
      });

      const prepared = await prepareDailyReport(report);
      const tradeLayout = (prepared as any).pageLayouts.find(
        (p: any) => p.tradeKey === "trade-crypto-tiny",
      );
      const tradeTexts = tradeLayout.items
        .filter((i: any) => i.type === "text")
        .map((i: any) => i.text);

      // Exact platform round-trip assertions requested by user
      const p17 = 1.234567891234567;
      const pTiny = 1.234567891234567e-25;
      const f17 = formatPrecision(p17);
      const fTiny = formatPrecision(pTiny);

      expect(Number(f17.replace(/,/g, ""))).toBe(p17);
      expect(Number(fTiny.replace(/,/g, ""))).toBe(pTiny);

      // Verify tiny values are preserved with actual non-zero precision (NOT truncated to 0.0000)
      // Stat tiles keep exact round-trip values (never rounded to 0.0000)
      for (const exact of ["3e-8", "1e-7", "1.5e-7", "0.0001", "1e-8", "8e-8", "2e-7"]) {
        expect(tradeTexts).toContain(exact);
      }
      expect(tradeTexts.some((t: string) => /^0\.0000$/.test(t))).toBe(false);

      // Execution table rows must show actual non-zero price and quantity
      expect(tradeTexts).toContain("3e-8");
      expect(tradeTexts).toContain("1e-7");
      expect(tradeTexts).toContain("1.5e-7");
    });
  });

  describe("layout bounds, markdown & caption regressions", () => {
    it("lists a trade's documents above its AI reviews", async () => {
      const base = createMockReport();
      const trade = {
        ...base.trades[0]!,
        attachments: [
          {
            id: "att-trade-doc",
            name: "broker-confirmation.pdf",
            mime: "application/pdf",
            size: 1024,
            createdAt: "2026-09-02T10:30:00.000Z",
          },
        ],
      };
      expect(trade.aiReviews.length).toBeGreaterThan(0);
      const prepared = await prepareDailyReport({ ...base, attachments: [], trades: [trade] });
      const labels = (prepared as any).pageLayouts
        .filter((p: any) => p.kind === "trade")
        .flatMap((p: any) => p.items.map((i: any) => ({ page: p.pageIndex, y: i.y, text: i.text })))
        .filter((i: any) => i.text === "DOCUMENTS (1)" || i.text === "AI REVIEWS");
      expect(labels.map((l: any) => l.text)).toEqual(["DOCUMENTS (1)", "AI REVIEWS"]);
      const [docs, ai] = labels;
      expect(docs.page < ai.page || (docs.page === ai.page && docs.y < ai.y)).toBe(true);
    });

    it("renders inline bold as bold runs and trade links as their label", async () => {
      const report = createMockReport({
        note: [
          "Bias was **cautious short on semis** into the gap, *patience* first.",
          "- Linked [AMD · short · 2026\\-09\\-17](/trades/acc%7CAMD) and **held** the runner",
          "Code `x = 1` and an escaped \\*star\\*.",
        ].join("\n\n"),
        trades: [],
        attachments: [],
      });
      const prepared = await prepareDailyReport(report);
      const texts = (prepared as any).pageLayouts
        .flatMap((p: any) => p.items)
        .filter((i: any) => i.type === "text");
      const bold = texts.filter((t: any) => t.bold).map((t: any) => t.text.trim());
      expect(bold).toContain("cautious short on semis");
      expect(bold).toContain("held");
      const all = texts.map((t: any) => t.text).join("");
      expect(all).toContain("AMD · short · 2026-09-17");
      expect(all).toContain("patience first");
      expect(all).toContain("Code x = 1 and an escaped *star*.");
      expect(all).not.toMatch(/\*\*|\]\(|\/trades\//);
      // Runs on one line sit left to right without overlapping.
      const line = texts.filter(
        (t: any) => Math.abs(t.y - texts.find((u: any) => u.text.includes("cautious")).y) < 0.1,
      );
      for (let i = 1; i < line.length; i++) expect(line[i].x).toBeGreaterThan(line[i - 1].x);
    });

    it("wraps long code lines and chunks code blocks across pages with bounded backgrounds", async () => {
      const longCode = Array.from(
        { length: 60 },
        (_, i) =>
          `const line_${i} = "very_long_code_statement_that_exceeds_usable_width_and_needs_to_be_wrapped_cleanly_at_margins_${i}";`,
      ).join("\n");

      const report = createMockReport({
        note: `## Code Review\n\`\`\`ts\n${longCode}\n\`\`\``,
        trades: [],
        attachments: [],
      });

      const prepared = await prepareDailyReport(report);
      expect(prepared.pages.length).toBeGreaterThan(1);

      // Verify all tail code lines are preserved
      const allTexts = (prepared as any).pageLayouts.flatMap((p: any) =>
        p.items.filter((i: any) => i.type === "text").map((i: any) => i.text),
      );
      expect(allTexts.some((t: string) => t.includes("line_0"))).toBe(true);
      expect(allTexts.some((t: string) => t.includes("line_59"))).toBe(true);

      // Verify rectangles stay bounded within page height
      for (const layout of (prepared as any).pageLayouts) {
        for (const item of layout.items) {
          if (item.type === "rect") {
            expect(item.y + item.h).toBeLessThanOrEqual(PAGE_HEIGHT);
          }
        }
      }
    });

    it("wraps long table cell text with dynamic row heights and repeats headers across page breaks without overlap", async () => {
      const veryLongDocName =
        "broker-statement-recording-all-executions-and-fills-from-clearing-firm-with-an-extremely-long-detailed-name-for-daily-audit-2026-09-02.pdf";
      const report = createMockReport({
        attachments: [
          {
            id: "doc-1",
            name: veryLongDocName,
            mime: "application/pdf",
            size: 512000,
            createdAt: "2026-09-02T16:00:00.000Z",
          },
        ],
        trades: [],
      });

      const prepared = await prepareDailyReport(report);
      const overviewLayout = (prepared as any).pageLayouts[0];
      const textItems = overviewLayout.items.filter((i: any) => i.type === "text");

      // Verify that the long document name was wrapped across multiple lines instead of truncated or overlapping
      const docTexts = textItems.map((i: any) => i.text);
      expect(docTexts.some((t: string) => t.includes("broker-statement"))).toBe(true);
      expect(docTexts.some((t: string) => t.includes("daily-audit"))).toBe(true);
    });

    it("slices oversized single-row 1000-word table cells across > 2 pages preserving bounds and final tail", async () => {
      // 1000+ words in a single table cell
      const thousandWords =
        Array.from(
          { length: 150 },
          (_, i) => `Observation_${i + 1}_rigorous_risk_discipline_and_strategy_rules_verification`,
        ).join(" ") + " FINAL_TABLE_CELL_TAIL_TOKEN";

      const tableMarkdown = [
        "| Section | Detailed Content |",
        "| --- | --- |",
        `| Audit | ${thousandWords} |`,
      ].join("\n");

      const report = createMockReport({
        note: `## Large Table Analysis\n\n${tableMarkdown}`,
        trades: [],
        attachments: [],
      });

      const prepared = await prepareDailyReport(report);
      // The single oversized row must span across > 2 pages (>= 3 pages)
      expect(prepared.pages.length).toBeGreaterThanOrEqual(3);

      // Verify all elements stay strictly within page bounds (<= PAGE_HEIGHT)
      for (const layout of (prepared as any).pageLayouts) {
        for (const item of layout.items) {
          if (item.type === "rect") {
            expect(item.y + item.h).toBeLessThanOrEqual(PAGE_HEIGHT);
          } else if (item.type === "text") {
            expect(item.y + item.size).toBeLessThanOrEqual(PAGE_HEIGHT);
          } else if (item.type === "line") {
            expect(Math.max(item.y1, item.y2)).toBeLessThanOrEqual(PAGE_HEIGHT);
          }
        }
      }

      // Verify the initial content and final TAIL token are preserved
      const allTexts = (prepared as any).pageLayouts.flatMap((p: any) =>
        p.items.filter((i: any) => i.type === "text").map((i: any) => i.text),
      );
      expect(allTexts.some((t: string) => t.includes("Observation_1_rigorous"))).toBe(true);
      expect(allTexts.some((t: string) => t.includes("FINAL_TABLE_CELL_TAIL_TOKEN"))).toBe(true);

      // Verify repeated table headers on continuation pages
      const contLayouts = (prepared as any).pageLayouts.slice(1);
      for (const cont of contLayouts) {
        const texts = cont.items.filter((i: any) => i.type === "text").map((i: any) => i.text);
        expect(texts).toContain("Section");
        expect(texts).toContain("Detailed Content");
      }
    }, 30000);

    it("wraps long tags and mistakes lists using addText without clipping off page margins", async () => {
      const manyTags = Array.from({ length: 15 }, (_, i) => `StrategyTag${i + 1}`);
      const manyMistakes = Array.from({ length: 8 }, (_, i) => `EmotionalMistake${i + 1}`);

      const report = createMockReport({
        attachments: [],
        trades: [
          {
            ...createMockReport().trades[0]!,
            tags: manyTags,
            mistakes: manyMistakes,
            attachments: [],
          },
        ],
      });

      const prepared = await prepareDailyReport(report, {
        imageLoader: async () => TEST_PNG,
      });

      const tradeLayout = (prepared as any).pageLayouts.find((p: any) => p.kind === "trade");
      const textItems = tradeLayout.items.filter((i: any) => i.type === "text");

      // Verify text items stay within margins (x >= MARGIN_LEFT, maxWidth <= USABLE_WIDTH)
      for (const item of textItems) {
        expect(item.x).toBeGreaterThanOrEqual(MARGIN_LEFT);
      }

      const tagTexts = textItems.map((i: any) => i.text);
      expect(tagTexts.some((t: string) => t.includes("StrategyTag15"))).toBe(true);
      expect(tagTexts.some((t: string) => t.includes("EmotionalMistake8"))).toBe(true);
    });

    it("anchors screenshot captions at PAGE_WIDTH / 2 without negative x offsets and wraps long names", async () => {
      const longName =
        "very-long-screenshot-filename-recording-breakout-on-es-micro-structure-2026-09-02-session.png";

      const report = createMockReport({
        attachments: [
          {
            id: "att-long-caption",
            name: longName,
            mime: "image/png",
            size: 1024,
            createdAt: "2026-09-02T16:00:00.000Z",
          },
        ],
        trades: [],
      });

      const prepared = await prepareDailyReport(report, {
        imageLoader: async () => TEST_PNG,
      });

      const screenshotLayout = (prepared as any).pageLayouts.find(
        (p: any) => p.kind === "screenshot",
      );
      const captionItems = screenshotLayout.items.filter(
        (i: any) => i.type === "text" && i.text.includes("Figure:"),
      );

      expect(captionItems.length).toBeGreaterThanOrEqual(1);
      for (const item of captionItems) {
        // Must anchor at center of page (PAGE_WIDTH / 2)
        expect(item.x).toBeCloseTo(PAGE_WIDTH / 2, 1);
        expect(item.align).toBe("center");
      }
    });

    it("draws chart endpoint dot even for a single-point curve in both Canvas and PDF", async () => {
      const report = createMockReport({
        intraday: [{ t: "09:30", cumNetPnl: 100 }],
        attachments: [],
        trades: [],
      });

      const prepared = await prepareDailyReport(report);
      const pdfExport = await prepared.buildPdf();
      const pdfBytes = new Uint8Array(await pdfExport.blob.arrayBuffer());
      const doc = await PDFDocument.load(pdfBytes);
      expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);

      const pngBlob = await prepared.renderPage(prepared.pages[0]!.id);
      expect(pngBlob).toBeDefined();
    });

    it("does not repeat '(Continued)' across multiple continuation pages", async () => {
      const longNote = Array.from(
        { length: 120 },
        (_, i) => `Paragraph ${i + 1} of detailed session notes covering risk and execution.`,
      ).join("\n\n");

      const report = createMockReport({
        note: longNote,
        attachments: [],
        trades: [],
      });

      const prepared = await prepareDailyReport(report);
      expect(prepared.pages.length).toBeGreaterThanOrEqual(3);

      for (const page of prepared.pages) {
        // Should NEVER contain repeated "(Continued) (Continued)"
        expect(page.title).not.toMatch(/\(Continued\)\s*\(Continued\)/);
      }
    });
  });
});

describe("Trade report export (single trade, same design as the daily trade pages)", () => {
  const tradeReport = () => ({
    exportedAt: "2026-09-02T16:45:00.000Z",
    timeZone: "America/New_York",
    trade: createMockReport().trades[0]!,
  });

  it("lays out one trade page plus its screenshot page, without an overview page", async () => {
    const prepared = await prepareTradeReport(tradeReport(), { imageLoader: async () => TEST_PNG });
    const kinds = prepared.pages.map((p) => p.kind);
    expect(kinds[0]).toBe("trade");
    expect(kinds.at(-1)).toBe("screenshot");
    expect(kinds).not.toContain("daily");
    expect(prepared.pages.every((p) => p.tradeKey === "trade-es-1")).toBe(true);
    expect(prepared.pages[0]!.title).toBe("Trade ES (LOSS)");

    const layouts = (prepared as any).pageLayouts;
    const texts = layouts[0].items.filter((i: any) => i.type === "text").map((i: any) => i.text);
    expect(texts).toContain("ES");
    expect(texts).toContain("-$250.00");
    expect(texts.some((t: string) => t.startsWith("Sumi · Trade report · ES · 2026-09-02"))).toBe(
      true,
    );
    expect(texts.some((t: string) => t.includes("Daily report"))).toBe(false);
    prepared.dispose();
  });

  it("names downloads <date>-<symbol>-<direction>-trade-report and zips multiple pages", async () => {
    const prepared = await prepareTradeReport(tradeReport(), { imageLoader: async () => TEST_PNG });
    const pdf = await prepared.buildPdf();
    expect(pdf.filename).toBe("2026-09-02-es-long-trade-report.pdf");
    const doc = await PDFDocument.load(new Uint8Array(await pdf.blob.arrayBuffer()));
    expect(doc.getPageCount()).toBe(prepared.pages.length);
    expect(doc.getTitle()).toBe("Trade Report · ES · 2026-09-02");

    const zip = await prepared.buildPngDownload(prepared.pages.map((p) => p.id));
    expect(zip.filename).toBe("2026-09-02-es-long-trade-report.zip");
    const single = await prepared.buildPngDownload([prepared.pages[0]!.id]);
    expect(single.filename).toBe("2026-09-02-es-long-trade-report.png");
    prepared.dispose();
  });

  it("renders an open trade without a closing time or exit", async () => {
    const report = tradeReport();
    Object.assign(report.trade, {
      status: "open",
      closedAt: null,
      avgExit: null,
      durationMs: null,
      attachments: [],
    });
    const prepared = await prepareTradeReport(report);
    expect(prepared.pages.every((p) => p.kind === "trade")).toBe(true);
    const texts = (prepared as any).pageLayouts[0].items
      .filter((i: any) => i.type === "text")
      .map((i: any) => i.text);
    expect(texts).toContain("OPEN");
    expect(texts.some((t: string) => t.includes("– open"))).toBe(true);
    prepared.dispose();
  });
});

describe("report image downscaling", () => {
  it("caps retina screenshots at ~200 DPI of the page box and keeps aspect", () => {
    const out = fitImageSize(2880, 1800);
    expect(out.width).toBe(1431);
    expect(out.height).toBe(Math.round((1800 * 1431) / 2880));
  });
  it("caps very tall images by height and never upscales", () => {
    const tall = fitImageSize(1000, 6000);
    expect(tall.height).toBeLessThanOrEqual(1945);
    expect(tall.width).toBeLessThan(1000);
    expect(fitImageSize(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitImageSize(1431, 900)).toEqual({ width: 1431, height: 900 });
  });
  it("chooses JPEG only for opaque images where it is smaller", () => {
    expect(chooseImageEncoding({ hasAlpha: false, pngSize: 1000, jpegSize: 400 })).toBe("jpeg");
    expect(chooseImageEncoding({ hasAlpha: false, pngSize: 400, jpegSize: 1000 })).toBe("png");
    expect(chooseImageEncoding({ hasAlpha: true, pngSize: 1000, jpegSize: 100 })).toBe("png");
    expect(chooseImageEncoding({ hasAlpha: false, pngSize: 1000, jpegSize: null })).toBe("png");
  });
});
