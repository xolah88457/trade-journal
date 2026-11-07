import type { ExportFile } from "./export-review";
import { PDFDocument, rgb } from "pdf-lib";
import type {
  DailyReport,
  DailyReportTrade,
  ReportAttachment,
  ReportExecution,
  ReportAiReview,
  ReportCurvePoint,
} from "./daily-report-types";
import { zipSync } from "fflate";
import {
  PAGE_WIDTH,
  PAGE_HEIGHT,
  COLORS,
  buildReportLayout,
  defaultMeasure,
  slugify,
  type LayoutItem,
  type ReportPageLayout,
  type NormalizedImage,
  type MeasureFn,
} from "./daily-report-layout";

export interface DailyReportPage {
  id: string;
  title: string;
  kind: "daily" | "trade" | "screenshot";
  tradeKey?: string;
}

export interface PreparedDailyReport {
  pages: DailyReportPage[];
  renderPage(pageId: string, scale?: number): Promise<Blob>;
  buildPdf(pageIds?: string[]): Promise<ExportFile>;
  buildPngDownload(pageIds: string[]): Promise<ExportFile>;
  dispose(): void;
}

export interface PrepareReportOptions {
  signal?: AbortSignal;
  imageLoader?: (att: ReportAttachment) => Promise<Uint8Array | Blob>;
}

// 1x1 Transparent PNG bytes fallback
const TINY_PNG = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0,
  0, 31, 21, 196, 137, 0, 0, 0, 11, 73, 68, 65, 84, 120, 156, 99, 96, 0, 0, 0, 2, 0, 1, 229, 39,
  222, 250, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
]);

async function blobToUint8Array(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === "function") {
    return new Uint8Array(await blob.arrayBuffer());
  }
  return new Uint8Array(await new Response(blob).arrayBuffer());
}

// Convert CSS hex color to RGB tuple (0..1)
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace("#", "");
  const num = parseInt(
    clean.length === 3
      ? clean
          .split("")
          .map((c) => c + c)
          .join("")
      : clean,
    16,
  );
  return {
    r: ((num >> 16) & 255) / 255,
    g: ((num >> 8) & 255) / 255,
    b: (num & 255) / 255,
  };
}

// ---------------------------------------------------------------------------
// Font Loader & Browser FontFace Registration
// ---------------------------------------------------------------------------

let cachedFontBytes: Uint8Array | null = null;
let fontFaceRegistered = false;

async function loadFontBytes(): Promise<Uint8Array> {
  if (cachedFontBytes) return cachedFontBytes;

  // Browser fetch only — no dynamic Node fs/path in client-importable code
  const res = await fetch("/fonts/NotoSans-Regular.ttf");
  if (!res.ok) {
    throw new Error(
      `Could not load PDF font /fonts/NotoSans-Regular.ttf (${res.status} ${res.statusText})`,
    );
  }
  const buffer = await res.arrayBuffer();
  cachedFontBytes = new Uint8Array(buffer);
  return cachedFontBytes;
}

/**
 * Registers the verified Noto Sans font bytes into document.fonts once before Canvas renders.
 * This ensures Canvas 2D uses the exact same Noto Sans glyph metrics as pdf-lib/fontkit,
 * preventing fallback to Arial and layout mismatch/text overflow between preview and PDF.
 */
async function ensureFontFaceRegistered(fontBytes: Uint8Array): Promise<void> {
  if (fontFaceRegistered) return;
  if (typeof document !== "undefined" && typeof FontFace !== "undefined" && document.fonts) {
    try {
      const fontFace = new FontFace("Noto Sans", fontBytes.buffer as ArrayBuffer);
      await fontFace.load();
      document.fonts.add(fontFace);
      await document.fonts.ready;
      fontFaceRegistered = true;
    } catch {
      // Safely continue if FontFace is mocked or unavailable in environment
    }
  }
}

// ---------------------------------------------------------------------------
// Image Fetching & Normalization (Honors EXIF Orientation)
// ---------------------------------------------------------------------------

async function fetchAttachmentImage(
  att: ReportAttachment,
  options?: PrepareReportOptions,
): Promise<Uint8Array> {
  if (options?.imageLoader) {
    const loaded = await options.imageLoader(att);
    if (loaded instanceof Uint8Array) return loaded;
    return new Uint8Array(await (loaded as Blob).arrayBuffer());
  }

  const base = typeof window !== "undefined" ? window.location.origin : "http://localhost";
  const url =
    typeof window !== "undefined"
      ? `/api/attachments/${encodeURIComponent(att.id)}`
      : new URL(`/api/attachments/${encodeURIComponent(att.id)}`, base).toString();

  const res = await fetch(url, {
    credentials: "same-origin",
    signal: options?.signal,
  });

  if (!res.ok) {
    // Critical: Do NOT silently omit 404/failed screenshots!
    throw new Error(
      `Failed to download screenshot "${att.name}" (${res.status} ${res.statusText || "Error"})`,
    );
  }

  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Normalizes image bytes and decodes EXIF orientation consistently with browser gallery.
 * In a browser with Canvas/createImageBitmap, the decoded bitmap is auto-oriented,
 * preserving natural upright aspect ratio and crisp readability.
 */
async function normalizeImage(rawBytes: Uint8Array, mime: string): Promise<NormalizedImage> {
  // Real browser environment with native createImageBitmap support
  if (
    typeof window !== "undefined" &&
    typeof document !== "undefined" &&
    typeof createImageBitmap === "function"
  ) {
    const blob = new Blob([rawBytes as unknown as BlobPart], { type: mime });
    let w = 800;
    let h = 600;
    let canvas: HTMLCanvasElement | null = null;
    let bitmap: ImageBitmap | null = null;

    try {
      // Modern browser auto-orients based on EXIF tag
      bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
      w = bitmap.width;
      h = bitmap.height;
      canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(bitmap, 0, 0);
      }
    } catch (err) {
      throw new Error(
        `Failed to decode image (${mime}): ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      if (bitmap && typeof bitmap.close === "function") {
        bitmap.close();
      }
    }

    if (canvas) {
      const outBlob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/png"),
      );
      canvas.width = 0;
      canvas.height = 0;
      if (outBlob) {
        const outBytes = await blobToUint8Array(outBlob);
        return { bytes: outBytes, mime: "image/png", width: w, height: h };
      }
      throw new Error(`Failed to export normalized image to PNG (${mime})`);
    }
  }

  // Node or headless fallback: detect dimensions from header or default
  let width = 800;
  let height = 600;
  if (rawBytes.length > 24 && rawBytes[0] === 0x89 && rawBytes[1] === 0x50) {
    // PNG Header
    const dv = new DataView(rawBytes.buffer, rawBytes.byteOffset, 24);
    width = dv.getUint32(16, false) || 800;
    height = dv.getUint32(20, false) || 600;
  } else if (rawBytes.length > 4 && rawBytes[0] === 0xff && rawBytes[1] === 0xd8) {
    // JPEG header: scan for SOF0/SOF2 marker
    try {
      let offset = 2;
      while (offset < rawBytes.length) {
        if (rawBytes[offset] === 0xff) {
          const marker = rawBytes[offset + 1];
          if (marker === 0xc0 || marker === 0xc2) {
            height = (rawBytes[offset + 5]! << 8) | rawBytes[offset + 6]!;
            width = (rawBytes[offset + 7]! << 8) | rawBytes[offset + 8]!;
            break;
          } else if (marker === 0xd9 || marker === 0xda) {
            break;
          } else {
            const len = (rawBytes[offset + 2]! << 8) | rawBytes[offset + 3]!;
            offset += 2 + len;
          }
        } else {
          offset++;
        }
      }
    } catch {
      // fallback
    }
  }

  return { bytes: rawBytes, mime: mime || "image/png", width: width || 800, height: height || 600 };
}

// Bounded concurrency pool for fetching multiple screenshot images safely
async function fetchAllScreenshots(
  attachments: ReportAttachment[],
  options?: PrepareReportOptions,
  concurrency = 3,
): Promise<Map<string, NormalizedImage>> {
  const images = attachments.filter((a) => a.mime.startsWith("image/"));
  const results = new Map<string, NormalizedImage>();
  let idx = 0;

  async function worker() {
    while (idx < images.length) {
      if (options?.signal?.aborted) {
        throw new Error("Report preparation aborted.");
      }
      const current = images[idx++];
      if (!current) break;
      const raw = await fetchAttachmentImage(current, options);
      const normalized = await normalizeImage(raw, current.mime);
      results.set(current.id, normalized);
    }
  }

  const pool = Array.from({ length: Math.min(concurrency, images.length) }, () => worker());
  await Promise.all(pool);
  return results;
}

// ---------------------------------------------------------------------------
// Canvas 2D Text Fallback for PDF Unicode / Emojis
// ---------------------------------------------------------------------------

async function renderTextToPng(
  text: string,
  fontSize: number,
  color: string,
  bold = false,
  scale = 2,
): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  if (typeof document === "undefined") {
    throw new Error(
      `Canvas 2D environment is required to render Unicode and emoji glyphs into PDF: "${text}"`,
    );
  }

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error(
      `Canvas 2D context is unavailable to render Unicode and emoji glyphs into PDF: "${text}"`,
    );
  }

  const scaledSize = Math.round(fontSize * scale);
  ctx.font = `${bold ? "bold " : ""}${scaledSize}px "Noto Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
  const metrics = ctx.measureText(text);
  const textWidth = metrics.width || text.length * fontSize * 0.6;
  const w = Math.max(1, Math.ceil(textWidth + 4 * scale));
  const h = Math.max(1, Math.ceil(fontSize * 1.45 * scale));

  canvas.width = w;
  canvas.height = h;

  ctx.font = `${bold ? "bold " : ""}${scaledSize}px "Noto Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
  ctx.fillStyle = color;
  ctx.textBaseline = "middle";
  ctx.fillText(text, 2 * scale, h / 2);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) {
    throw new Error(`Failed to encode rendered Unicode glyph text to PNG: "${text}"`);
  }
  const bytes = await blobToUint8Array(blob);
  return { bytes, width: w / scale, height: h / scale };
}

// ---------------------------------------------------------------------------
// Prepared Daily Report Implementation
// ---------------------------------------------------------------------------

class PreparedDailyReportImpl implements PreparedDailyReport {
  pages: DailyReportPage[];
  private pageLayouts: ReportPageLayout[];
  private report: DailyReport;
  private normalizedImages: Map<string, NormalizedImage>;
  private abortController: AbortController;
  private fontBytes: Uint8Array;

  constructor(
    report: DailyReport,
    pageLayouts: ReportPageLayout[],
    normalizedImages: Map<string, NormalizedImage>,
    abortController: AbortController,
    fontBytes: Uint8Array,
  ) {
    this.report = report;
    this.pageLayouts = pageLayouts;
    this.normalizedImages = normalizedImages;
    this.abortController = abortController;
    this.fontBytes = fontBytes;

    this.pages = pageLayouts.map((p) => ({
      id: p.id,
      title: p.title,
      kind: p.kind,
      tradeKey: p.tradeKey,
    }));
  }

  async renderPage(pageId: string, scale = 2): Promise<Blob> {
    const layout = this.pageLayouts.find((p) => p.id === pageId);
    if (!layout) {
      throw new Error(`Page not found: "${pageId}"`);
    }

    if (typeof document === "undefined") {
      // Headless / mock environment
      return new Blob([TINY_PNG as unknown as BlobPart], { type: "image/png" });
    }

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(PAGE_WIDTH * scale);
    canvas.height = Math.round(PAGE_HEIGHT * scale);
    const ctx = canvas.getContext("2d");

    if (!ctx) {
      // In tests where canvas.getContext('2d') is null or mocked
      return new Blob([TINY_PNG as unknown as BlobPart], { type: "image/png" });
    }

    // Paint page parchment background
    ctx.fillStyle = COLORS.pageBg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.scale(scale, scale);

    // Draw all layout items
    for (const item of layout.items) {
      if (item.type === "rect") {
        if (item.fill) {
          ctx.fillStyle = item.fill;
          if (item.radius && typeof (ctx as any).roundRect === "function") {
            ctx.beginPath();
            (ctx as any).roundRect(item.x, item.y, item.w, item.h, item.radius);
            ctx.fill();
          } else {
            ctx.fillRect(item.x, item.y, item.w, item.h);
          }
        }
        if (item.stroke) {
          ctx.strokeStyle = item.stroke;
          ctx.lineWidth = item.lineWidth ?? 1;
          if (item.radius && typeof (ctx as any).roundRect === "function") {
            ctx.beginPath();
            (ctx as any).roundRect(item.x, item.y, item.w, item.h, item.radius);
            ctx.stroke();
          } else {
            ctx.strokeRect(item.x, item.y, item.w, item.h);
          }
        }
      } else if (item.type === "line") {
        ctx.strokeStyle = item.stroke;
        ctx.lineWidth = item.lineWidth ?? 1;
        ctx.beginPath();
        if (item.dash && typeof ctx.setLineDash === "function") {
          ctx.setLineDash(item.dash);
        } else if (typeof ctx.setLineDash === "function") {
          ctx.setLineDash([]);
        }
        ctx.moveTo(item.x1, item.y1);
        ctx.lineTo(item.x2, item.y2);
        ctx.stroke();
        if (typeof ctx.setLineDash === "function") ctx.setLineDash([]);
      } else if (item.type === "text") {
        ctx.fillStyle = item.color;
        ctx.font = `${item.bold ? "bold " : ""}${item.size}px "Noto Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
        ctx.textAlign = item.align ?? "left";
        ctx.textBaseline = "top";
        ctx.fillText(item.text, item.x, item.y);
      } else if (item.type === "badge") {
        ctx.fillStyle = item.bgColor;
        ctx.font = `bold ${item.size}px "Noto Sans", sans-serif`;
        const textW = ctx.measureText(item.text).width;
        const padX = item.paddingX ?? 4;
        const padY = item.paddingY ?? 2;
        const bw = textW + padX * 2;
        const bh = item.size + padY * 2 + 2;

        ctx.fillRect(item.x, item.y, bw, bh);
        if (item.borderColor) {
          ctx.strokeStyle = item.borderColor;
          ctx.lineWidth = 0.5;
          ctx.strokeRect(item.x, item.y, bw, bh);
        }
        ctx.fillStyle = item.color;
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.fillText(item.text, item.x + padX, item.y + padY);
      } else if (item.type === "chart") {
        this.renderChartOnCanvas(ctx, item);
      } else if (item.type === "image") {
        if (
          typeof Image !== "undefined" &&
          typeof URL !== "undefined" &&
          typeof URL.createObjectURL === "function"
        ) {
          const blob = new Blob([item.bytes as unknown as BlobPart], { type: item.mime });
          const url = URL.createObjectURL(blob);
          const img = new Image();
          img.src = url;
          try {
            await new Promise((res, rej) => {
              img.onload = res;
              img.onerror = rej;
              setTimeout(res, 30);
            });
            ctx.drawImage(img, item.x, item.y, item.w, item.h);
          } catch {
            // Draw image placeholder if decode fails
            ctx.strokeStyle = COLORS.cardBorder;
            ctx.strokeRect(item.x, item.y, item.w, item.h);
          } finally {
            URL.revokeObjectURL(url);
          }
        }
      }
    }

    ctx.restore();

    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("Canvas toBlob failed"))),
        "image/png",
      );
    });
  }

  private renderChartOnCanvas(
    ctx: CanvasRenderingContext2D,
    chart: LayoutItem & { type: "chart" },
  ): void {
    const { x, y, w, h, points, currency = "USD" } = chart;

    // Card background
    ctx.fillStyle = COLORS.cardBg;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = COLORS.cardBorder;
    ctx.lineWidth = 0.75;
    ctx.strokeRect(x, y, w, h);

    // Title
    ctx.fillStyle = COLORS.navyBrand;
    ctx.font = "bold 8px 'Noto Sans', sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(chart.title || "Equity Curve", x + 6, y + 4);

    if (!points || points.length === 0) {
      ctx.fillStyle = COLORS.textMuted;
      ctx.font = "8px 'Noto Sans', sans-serif";
      ctx.fillText("No curve points recorded.", x + 8, y + 20);
      return;
    }

    const minPnl = Math.min(0, ...points.map((p) => p.cumNetPnl));
    const maxPnl = Math.max(0, ...points.map((p) => p.cumNetPnl));
    const range = maxPnl - minPnl || 1;

    const left = x + 44;
    const right = x + w - 12;
    const top = y + 18;
    const bottom = y + h - 14;
    const innerW = right - left;
    const innerH = bottom - top;

    const zeroY = bottom - ((0 - minPnl) / range) * innerH;

    // Zero baseline
    ctx.strokeStyle = COLORS.baseline;
    ctx.lineWidth = 0.75;
    if (typeof ctx.setLineDash === "function") ctx.setLineDash([3, 2]);
    ctx.beginPath();
    ctx.moveTo(left, zeroY);
    ctx.lineTo(right, zeroY);
    ctx.stroke();
    if (typeof ctx.setLineDash === "function") ctx.setLineDash([]);

    // Axes labels
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = "6.5px 'Noto Sans', sans-serif";
    ctx.textAlign = "right";
    ctx.fillText("0", left - 4, zeroY - 3);
    ctx.fillText(`+${maxPnl.toFixed(0)}`, left - 4, top - 3);
    ctx.fillText(`${minPnl.toFixed(0)}`, left - 4, bottom - 3);

    // Plot line
    const coords: { cx: number; cy: number }[] = points.map((p, idx) => {
      const cx = left + (idx / Math.max(1, points.length - 1)) * innerW;
      const cy = bottom - ((p.cumNetPnl - minPnl) / range) * innerH;
      return { cx, cy };
    });

    const finalVal = points[points.length - 1]?.cumNetPnl ?? 0;
    const lineColor = finalVal >= 0 ? COLORS.profitGreen : COLORS.lossRed;

    // Draw shaded area
    ctx.fillStyle = finalVal >= 0 ? "rgba(12, 163, 12, 0.12)" : "rgba(195, 53, 53, 0.12)";
    ctx.beginPath();
    ctx.moveTo(coords[0]!.cx, zeroY);
    coords.forEach((c) => ctx.lineTo(c.cx, c.cy));
    ctx.lineTo(coords[coords.length - 1]!.cx, zeroY);
    ctx.closePath();
    ctx.fill();

    // Draw curve
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.moveTo(coords[0]!.cx, coords[0]!.cy);
    for (let i = 1; i < coords.length; i++) {
      ctx.lineTo(coords[i]!.cx, coords[i]!.cy);
    }
    ctx.stroke();

    // Final point marker
    const last = coords[coords.length - 1]!;
    ctx.fillStyle = lineColor;
    ctx.beginPath();
    ctx.arc(last.cx, last.cy, 2.5, 0, Math.PI * 2);
    ctx.fill();

    // End label
    const curLabel = currency === "MIXED" ? "(Mixed)" : currency;
    ctx.font = "bold 7px 'Noto Sans', sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(`${finalVal > 0 ? "+" : ""}${finalVal.toFixed(2)} ${curLabel}`, right, top - 4);
  }

  private resolveSelectedPageLayouts(pageIds?: string[]): ReportPageLayout[] {
    if (pageIds === undefined) {
      return this.pageLayouts;
    }

    if (!Array.isArray(pageIds) || pageIds.length === 0) {
      throw new Error("Select at least one page to download.");
    }

    // Validate page IDs
    for (const id of pageIds) {
      if (!this.pages.some((p) => p.id === id)) {
        throw new Error(`Invalid page ID: "${id}".`);
      }
    }

    const selectedSet = new Set(pageIds);
    return this.pageLayouts.filter((p) => selectedSet.has(p.id));
  }

  async buildPdf(pageIds?: string[]): Promise<ExportFile> {
    const selectedLayouts = this.resolveSelectedPageLayouts(pageIds);

    const { default: fontkit } = await import("@pdf-lib/fontkit");

    const pdfDoc = await PDFDocument.create();
    pdfDoc.registerFontkit(fontkit);
    pdfDoc.setTitle(`Daily Report · ${this.report.date}`);
    pdfDoc.setCreator("Sumi");

    const font = await pdfDoc.embedFont(this.fontBytes, { subset: true });
    const supportedChars = new Set(font.getCharacterSet());

    for (const layout of selectedLayouts) {
      const pdfPage = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);

      // Page background
      const bg = hexToRgb(COLORS.pageBg);
      pdfPage.drawRectangle({
        x: 0,
        y: 0,
        width: PAGE_WIDTH,
        height: PAGE_HEIGHT,
        color: rgb(bg.r, bg.g, bg.b),
      });

      for (const item of layout.items) {
        if (item.type === "rect") {
          const pdfY = PAGE_HEIGHT - item.y - item.h;
          const fill = item.fill ? hexToRgb(item.fill) : undefined;
          const stroke = item.stroke ? hexToRgb(item.stroke) : undefined;
          pdfPage.drawRectangle({
            x: item.x,
            y: pdfY,
            width: item.w,
            height: item.h,
            color: fill ? rgb(fill.r, fill.g, fill.b) : undefined,
            borderColor: stroke ? rgb(stroke.r, stroke.g, stroke.b) : undefined,
            borderWidth: item.lineWidth ?? 0.75,
          });
        } else if (item.type === "line") {
          const pdfY1 = PAGE_HEIGHT - item.y1;
          const pdfY2 = PAGE_HEIGHT - item.y2;
          const stroke = hexToRgb(item.stroke);
          pdfPage.drawLine({
            start: { x: item.x1, y: pdfY1 },
            end: { x: item.x2, y: pdfY2 },
            color: rgb(stroke.r, stroke.g, stroke.b),
            thickness: item.lineWidth ?? 0.75,
          });
        } else if (item.type === "text") {
          await this.drawTextInPdf(pdfPage, pdfDoc, font, supportedChars, item);
        } else if (item.type === "badge") {
          // Badge background
          const bg = hexToRgb(item.bgColor);
          const border = item.borderColor ? hexToRgb(item.borderColor) : undefined;
          const padX = item.paddingX ?? 4;
          const padY = item.paddingY ?? 2;
          const textW = item.text.length * item.size * 0.65;
          const bw = textW + padX * 2;
          const bh = item.size + padY * 2 + 2;
          const pdfY = PAGE_HEIGHT - item.y - bh;

          pdfPage.drawRectangle({
            x: item.x,
            y: pdfY,
            width: bw,
            height: bh,
            color: rgb(bg.r, bg.g, bg.b),
            borderColor: border ? rgb(border.r, border.g, border.b) : undefined,
            borderWidth: border ? 0.5 : 0,
          });

          await this.drawTextInPdf(pdfPage, pdfDoc, font, supportedChars, {
            x: item.x + padX,
            y: item.y + padY + 1,
            text: item.text,
            size: item.size,
            bold: true,
            color: item.color,
          });
        } else if (item.type === "chart") {
          this.drawChartInPdf(pdfPage, font, item);
        } else if (item.type === "image") {
          try {
            const img = await pdfDoc.embedPng(item.bytes);
            const pdfY = PAGE_HEIGHT - item.y - item.h;
            pdfPage.drawImage(img, {
              x: item.x,
              y: pdfY,
              width: item.w,
              height: item.h,
            });
          } catch {
            // If PNG embed fails (e.g. raw JPEG), try embedJpg
            try {
              const img = await pdfDoc.embedJpg(item.bytes);
              const pdfY = PAGE_HEIGHT - item.y - item.h;
              pdfPage.drawImage(img, {
                x: item.x,
                y: pdfY,
                width: item.w,
                height: item.h,
              });
            } catch {
              // Draw fallback box
              const pdfY = PAGE_HEIGHT - item.y - item.h;
              pdfPage.drawRectangle({
                x: item.x,
                y: pdfY,
                width: item.w,
                height: item.h,
                borderColor: rgb(0.8, 0.8, 0.8),
                borderWidth: 1,
              });
            }
          }
        }
      }
    }

    const pdfBytes = await pdfDoc.save();
    return {
      blob: new Blob([pdfBytes as unknown as BlobPart], { type: "application/pdf" }),
      filename: `${this.report.date}-daily-report.pdf`,
    };
  }

  private async drawTextInPdf(
    pdfPage: any,
    pdfDoc: any,
    font: any,
    supportedChars: Set<number>,
    item: {
      x: number;
      y: number;
      text: string;
      size: number;
      bold?: boolean;
      color: string;
      align?: "left" | "center" | "right";
      maxWidth?: number;
    },
  ): Promise<void> {
    if (!item.text) return;

    // Check if all characters are supported by NotoSans
    const isSupported = [...item.text].every((c) => {
      const code = c.codePointAt(0);
      return code !== undefined && (code === 32 || code === 9 || supportedChars.has(code));
    });

    if (isSupported) {
      let x = item.x;
      const textWidth = font.widthOfTextAtSize(item.text, item.size);
      if (item.align === "right") {
        x = item.x - textWidth;
      } else if (item.align === "center") {
        x = item.x - textWidth / 2;
      }

      const pdfY = PAGE_HEIGHT - item.y - item.size;
      const c = hexToRgb(item.color);

      pdfPage.drawText(item.text, {
        x,
        y: pdfY,
        size: item.size,
        font,
        color: rgb(c.r, c.g, c.b),
      });
      return;
    }

    // Unsupported glyphs / emojis (e.g. 🚀, ★, etc.)
    // Canvas-render text to preserve exact characters without dropping or replacing with [emoji]
    const rendered = await renderTextToPng(item.text, item.size, item.color, item.bold);
    const img = await pdfDoc.embedPng(rendered.bytes);
    let x = item.x;
    if (item.align === "right") {
      x = item.x - rendered.width;
    } else if (item.align === "center") {
      x = item.x - rendered.width / 2;
    }

    const pdfY = PAGE_HEIGHT - item.y - item.size * 1.25;
    pdfPage.drawImage(img, {
      x,
      y: pdfY,
      width: rendered.width,
      height: rendered.height,
    });
  }

  private drawChartInPdf(pdfPage: any, font: any, chart: LayoutItem & { type: "chart" }): void {
    const { x, y, w, h, points, currency = "USD" } = chart;

    const pdfY = PAGE_HEIGHT - y - h;
    const cardBg = hexToRgb(COLORS.cardBg);
    const cardBorder = hexToRgb(COLORS.cardBorder);

    // Box
    pdfPage.drawRectangle({
      x,
      y: pdfY,
      width: w,
      height: h,
      color: rgb(cardBg.r, cardBg.g, cardBg.b),
      borderColor: rgb(cardBorder.r, cardBorder.g, cardBorder.b),
      borderWidth: 0.75,
    });

    // Chart title
    const navy = hexToRgb(COLORS.navyBrand);
    pdfPage.drawText(chart.title || "Equity Curve", {
      x: x + 6,
      y: PAGE_HEIGHT - y - 10,
      size: 7.5,
      font,
      color: rgb(navy.r, navy.g, navy.b),
    });

    if (!points || points.length === 0) {
      const textMuted = hexToRgb(COLORS.textMuted);
      pdfPage.drawText("No curve points recorded.", {
        x: x + 8,
        y: PAGE_HEIGHT - y - 24,
        size: 7.5,
        font,
        color: rgb(textMuted.r, textMuted.g, textMuted.b),
      });
      return;
    }

    const minPnl = Math.min(0, ...points.map((p) => p.cumNetPnl));
    const maxPnl = Math.max(0, ...points.map((p) => p.cumNetPnl));
    const range = maxPnl - minPnl || 1;

    const left = x + 44;
    const right = x + w - 12;
    const top = y + 18;
    const bottom = y + h - 14;
    const innerW = right - left;
    const innerH = bottom - top;

    const zeroY = bottom - ((0 - minPnl) / range) * innerH;
    const baselinePdfY = PAGE_HEIGHT - zeroY;

    // Zero baseline
    const baseC = hexToRgb(COLORS.baseline);
    pdfPage.drawLine({
      start: { x: left, y: baselinePdfY },
      end: { x: right, y: baselinePdfY },
      color: rgb(baseC.r, baseC.g, baseC.b),
      thickness: 0.75,
    });

    // Labels
    const mutedC = hexToRgb(COLORS.textMuted);
    pdfPage.drawText("0", {
      x: x + 6,
      y: baselinePdfY - 2.5,
      size: 6.5,
      font,
      color: rgb(mutedC.r, mutedC.g, mutedC.b),
    });
    pdfPage.drawText(`+${maxPnl.toFixed(0)}`, {
      x: x + 6,
      y: PAGE_HEIGHT - top - 3,
      size: 6.5,
      font,
      color: rgb(mutedC.r, mutedC.g, mutedC.b),
    });
    pdfPage.drawText(`${minPnl.toFixed(0)}`, {
      x: x + 6,
      y: PAGE_HEIGHT - bottom - 3,
      size: 6.5,
      font,
      color: rgb(mutedC.r, mutedC.g, mutedC.b),
    });

    // Plot segments
    const coords = points.map((p, idx) => ({
      cx: left + (idx / Math.max(1, points.length - 1)) * innerW,
      cy: PAGE_HEIGHT - (bottom - ((p.cumNetPnl - minPnl) / range) * innerH),
    }));

    const finalVal = points[points.length - 1]?.cumNetPnl ?? 0;
    const lineC = hexToRgb(finalVal >= 0 ? COLORS.profitGreen : COLORS.lossRed);

    for (let i = 0; i < coords.length - 1; i++) {
      const p1 = coords[i]!;
      const p2 = coords[i + 1]!;
      pdfPage.drawLine({
        start: { x: p1.cx, y: p1.cy },
        end: { x: p2.cx, y: p2.cy },
        color: rgb(lineC.r, lineC.g, lineC.b),
        thickness: 1.25,
      });
    }

    // Endpoint dot (drawn even for a 1-point curve to match Canvas)
    const last = coords[coords.length - 1]!;
    pdfPage.drawCircle({
      x: last.cx,
      y: last.cy,
      size: 2.5,
      color: rgb(lineC.r, lineC.g, lineC.b),
    });

    // Final label
    const curLabel = currency === "MIXED" ? "(Mixed)" : currency;
    const endText = `${finalVal > 0 ? "+" : ""}${finalVal.toFixed(2)} ${curLabel}`;
    const endW = font.widthOfTextAtSize(endText, 7);
    pdfPage.drawText(endText, {
      x: right - endW,
      y: PAGE_HEIGHT - top - 4,
      size: 7,
      font,
      color: rgb(lineC.r, lineC.g, lineC.b),
    });
  }

  async buildPngDownload(pageIds: string[]): Promise<ExportFile> {
    if (!pageIds || pageIds.length === 0) {
      throw new Error("Select at least one page to download.");
    }

    // Validate page IDs
    for (const id of pageIds) {
      if (!this.pages.some((p) => p.id === id)) {
        throw new Error(`Invalid page ID: "${id}".`);
      }
    }

    const selectedSet = new Set(pageIds);
    const selected = this.pages.filter((p) => selectedSet.has(p.id));

    // Single PNG selection
    if (selected.length === 1) {
      const page = selected[0]!;
      const pageNum = this.pages.indexOf(page) + 1;
      const blob = await this.renderPage(page.id, 2);
      const filename = `${this.report.date}-daily-report-${String(pageNum).padStart(2, "0")}-${slugify(page.title)}.png`;
      return { blob, filename };
    }

    // Multi-page ZIP selection: Maintain deterministic page order
    const entries: Record<string, Uint8Array> = {};

    for (const page of selected) {
      const pageNum = this.pages.indexOf(page) + 1;
      const blob = await this.renderPage(page.id, 2);
      const entryName = `${String(pageNum).padStart(2, "0")}-${slugify(page.title)}.png`;
      entries[entryName] = await blobToUint8Array(blob);
    }

    const zipBytes = zipSync(entries, { level: 6 });
    const zipBlob = new Blob([zipBytes as unknown as BlobPart], { type: "application/zip" });
    const filename = `${this.report.date}-daily-report.zip`;
    return { blob: zipBlob, filename };
  }

  dispose(): void {
    this.abortController.abort();
    this.normalizedImages.clear();
  }
}

// ---------------------------------------------------------------------------
// Main Public Function: prepareDailyReport
// ---------------------------------------------------------------------------

export async function prepareDailyReport(
  report: DailyReport,
  options?: PrepareReportOptions,
): Promise<PreparedDailyReport> {
  const abortController = new AbortController();
  if (options?.signal) {
    options.signal.addEventListener("abort", () => abortController.abort());
  }

  // 1. Gather all attachments
  const allAttachments: ReportAttachment[] = [
    ...(report.attachments || []),
    ...(report.trades?.flatMap((t) => t.attachments || []) || []),
  ];

  // 2. Fetch and normalize screenshot images with bounded concurrency
  const normalizedImages = await fetchAllScreenshots(allAttachments, options);

  // 3. Load font bytes, register FontFace for Canvas, and prepare fontkit layout measurement
  const fontBytes = await loadFontBytes();
  await ensureFontFaceRegistered(fontBytes);

  let measure: MeasureFn = defaultMeasure;
  try {
    const { default: fontkit } = await import("@pdf-lib/fontkit");
    const parsedFont = (fontkit as any).create(fontBytes);
    if (parsedFont && typeof parsedFont.layout === "function") {
      measure = (text: string, size: number) => {
        const layout = parsedFont.layout(text);
        return (layout.advanceWidth / parsedFont.unitsPerEm) * size;
      };
    }
  } catch {
    measure = defaultMeasure;
  }

  // 4. Deterministically compute shared layout representation
  const pageLayouts = buildReportLayout(report, normalizedImages, measure);

  return new PreparedDailyReportImpl(
    report,
    pageLayouts,
    normalizedImages,
    abortController,
    fontBytes,
  );
}
