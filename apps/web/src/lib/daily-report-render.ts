import type { ExportFile } from "./export-review";
import {
  PDFDocument,
  TextRenderingMode,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setLineWidth,
  setStrokingRgbColor,
  setTextRenderingMode,
} from "pdf-lib";
import type {
  DailyReport,
  TradeReport,
  DailyReportTrade,
  ReportAttachment,
  ReportExecution,
  ReportAiReview,
  ReportCurvePoint,
} from "./daily-report-types";
import { zipSync } from "fflate";
import { loadFontBytes } from "./pdf-font";
import {
  PAGE_WIDTH,
  PAGE_HEIGHT,
  USABLE_WIDTH,
  COLORS,
  buildReportLayout,
  buildTradeReportLayout,
  defaultMeasure,
  slugify,
  tradeReportDate,
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

/** pdf-lib drawing options for an optional fill and optional stroke (never a default black stroke). */
function shapeOptions(fill?: string, stroke?: string, lineWidth = 0.75) {
  const o: {
    color?: ReturnType<typeof rgb>;
    borderColor?: ReturnType<typeof rgb>;
    borderWidth?: number;
  } = {};
  if (fill) {
    const c = hexToRgb(fill);
    o.color = rgb(c.r, c.g, c.b);
  }
  if (stroke) {
    const c = hexToRgb(stroke);
    o.borderColor = rgb(c.r, c.g, c.b);
    o.borderWidth = lineWidth;
  }
  return o;
}

/** SVG path (y down) of a rounded rectangle, matching canvas roundRect. */
function roundedRectPath(x: number, y: number, w: number, h: number, radius: number): string {
  const r = Math.min(radius, w / 2, h / 2);
  return (
    `M${x + r} ${y} H${x + w - r} A${r} ${r} 0 0 1 ${x + w} ${y + r} V${y + h - r} ` +
    `A${r} ${r} 0 0 1 ${x + w - r} ${y + h} H${x + r} A${r} ${r} 0 0 1 ${x} ${y + h - r} ` +
    `V${y + r} A${r} ${r} 0 0 1 ${x + r} ${y} Z`
  );
}

// ---------------------------------------------------------------------------
// Font Loader & Browser FontFace Registration
// ---------------------------------------------------------------------------

let fontFaceRegistered = false;

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

/** Target print density for embedded report images. */
export const REPORT_IMAGE_DPI = 200;
/** Largest box (in PDF points) an image can be drawn in: usable page width by the tallest screenshot area. */
const IMAGE_BOX_PT = { width: USABLE_WIDTH, height: 700 };
const IMAGE_BOX_PX = {
  width: Math.round((IMAGE_BOX_PT.width * REPORT_IMAGE_DPI) / 72),
  height: Math.round((IMAGE_BOX_PT.height * REPORT_IMAGE_DPI) / 72),
};
const REPORT_JPEG_QUALITY = 0.85;

/** Aspect-fit the image into the ~200 DPI pixel box of the page; never upscales. */
export function fitImageSize(width: number, height: number): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width, height };
  const scale = Math.min(IMAGE_BOX_PX.width / width, IMAGE_BOX_PX.height / height, 1);
  if (scale >= 1) return { width, height };
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** JPEG only for fully opaque images where it is actually smaller than the lossless PNG. */
export function chooseImageEncoding(opts: {
  hasAlpha: boolean;
  pngSize: number;
  jpegSize: number | null;
}): "png" | "jpeg" {
  if (opts.hasAlpha || opts.jpegSize === null) return "png";
  return opts.jpegSize < opts.pngSize ? "jpeg" : "png";
}

function canvasHasAlpha(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  try {
    const data = ctx.getImageData(0, 0, w, h).data;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i]! < 255) return true;
    }
    return false;
  } catch {
    // Unreadable canvas: stay lossless.
    return true;
  }
}

/**
 * Normalizes image bytes and decodes EXIF orientation consistently with browser gallery.
 * In a browser with Canvas/createImageBitmap, the decoded bitmap is auto-oriented,
 * preserving natural upright aspect ratio and crisp readability.
 */
async function normalizeImage(rawBytes: Uint8Array, mime: string): Promise<NormalizedImage> {
  // width/height describe the (possibly downscaled) embedded raster; originalWidth/originalHeight
  // carry the uploaded image's oriented pixel size for captions.
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
    let hasAlpha = false;
    let origW = w;
    let origH = h;

    try {
      // Modern browser auto-orients based on EXIF tag
      bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
      const size = fitImageSize(bitmap.width, bitmap.height);
      origW = bitmap.width;
      origH = bitmap.height;
      w = size.width;
      h = size.height;
      canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(bitmap, 0, 0, w, h);
        hasAlpha = canvasHasAlpha(ctx, w, h);
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
      const pngBlob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/png"),
      );
      let jpegBlob: Blob | null = null;
      if (pngBlob && !hasAlpha) {
        jpegBlob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, "image/jpeg", REPORT_JPEG_QUALITY),
        );
      }
      canvas.width = 0;
      canvas.height = 0;
      if (pngBlob) {
        const choice = chooseImageEncoding({
          hasAlpha,
          pngSize: pngBlob.size,
          // Some engines silently fall back to PNG when JPEG is unsupported.
          jpegSize: jpegBlob && jpegBlob.type === "image/jpeg" ? jpegBlob.size : null,
        });
        const outBlob = choice === "jpeg" && jpegBlob ? jpegBlob : pngBlob;
        const outBytes = await blobToUint8Array(outBlob);
        return {
          bytes: outBytes,
          mime: choice === "jpeg" && jpegBlob ? "image/jpeg" : "image/png",
          width: w,
          height: h,
          originalWidth: origW,
          originalHeight: origH,
        };
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

/** Titles and filenames that differ between the day report and the single-trade report. */
interface ReportNaming {
  pdfTitle: string;
  pdfName: string;
  zipName: string;
  singlePngName(pageNum: number, page: DailyReportPage): string;
}

class PreparedDailyReportImpl implements PreparedDailyReport {
  pages: DailyReportPage[];
  private pageLayouts: ReportPageLayout[];
  private naming: ReportNaming;
  private normalizedImages: Map<string, NormalizedImage>;
  private abortController: AbortController;
  private fontBytes: Uint8Array;

  constructor(
    naming: ReportNaming,
    pageLayouts: ReportPageLayout[],
    normalizedImages: Map<string, NormalizedImage>,
    abortController: AbortController,
    fontBytes: Uint8Array,
  ) {
    this.naming = naming;
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
    // pdf-lib draws without kerning and the layout measures that way; match it so runs line up.
    ctx.fontKerning = "none";

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
      } else if (item.type === "path") {
        ctx.beginPath();
        item.points.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
        if (item.closed) ctx.closePath();
        if (item.fill) {
          ctx.fillStyle = item.fill;
          ctx.fill();
        }
        if (item.stroke) {
          ctx.strokeStyle = item.stroke;
          ctx.lineWidth = item.lineWidth ?? 1;
          ctx.lineJoin = "round";
          ctx.stroke();
        }
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
    pdfDoc.setTitle(this.naming.pdfTitle);
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
          const shape = shapeOptions(item.fill, item.stroke, item.lineWidth);
          if (!("color" in shape) && !("borderColor" in shape)) continue;
          if (item.radius && item.radius > 0) {
            pdfPage.drawSvgPath(roundedRectPath(item.x, item.y, item.w, item.h, item.radius), {
              x: 0,
              y: PAGE_HEIGHT,
              ...shape,
            });
          } else {
            pdfPage.drawRectangle({
              x: item.x,
              y: PAGE_HEIGHT - item.y - item.h,
              width: item.w,
              height: item.h,
              ...shape,
            });
          }
        } else if (item.type === "line") {
          const stroke = hexToRgb(item.stroke);
          pdfPage.drawLine({
            start: { x: item.x1, y: PAGE_HEIGHT - item.y1 },
            end: { x: item.x2, y: PAGE_HEIGHT - item.y2 },
            color: rgb(stroke.r, stroke.g, stroke.b),
            thickness: item.lineWidth ?? 1,
            dashArray: item.dash,
          });
        } else if (item.type === "path") {
          const d =
            item.points.map(([px, py], i) => `${i ? "L" : "M"}${px} ${py}`).join(" ") +
            (item.closed ? " Z" : "");
          pdfPage.drawSvgPath(d, {
            x: 0,
            y: PAGE_HEIGHT,
            ...shapeOptions(item.fill, item.stroke, item.lineWidth),
          });
        } else if (item.type === "text") {
          await this.drawTextInPdf(pdfPage, pdfDoc, font, supportedChars, item);
        } else if (item.type === "image") {
          try {
            const img =
              item.mime === "image/jpeg"
                ? await pdfDoc.embedJpg(item.bytes)
                : await pdfDoc.embedPng(item.bytes);
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
      filename: this.naming.pdfName,
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

      // Single regular font embedded: bold is synthesized with a same-colour stroke (fill + stroke
      // text render mode), mirroring how canvas synthesizes bold from the one registered FontFace.
      if (item.bold) {
        pdfPage.pushOperators(
          pushGraphicsState(),
          setTextRenderingMode(TextRenderingMode.FillAndOutline),
          setStrokingRgbColor(c.r, c.g, c.b),
          setLineWidth(item.size * 0.035),
        );
      }
      pdfPage.drawText(item.text, {
        x,
        y: pdfY,
        size: item.size,
        font,
        color: rgb(c.r, c.g, c.b),
      });
      if (item.bold) pdfPage.pushOperators(popGraphicsState());
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
      const filename = this.naming.singlePngName(pageNum, page);
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

    // PNG data is already deflated, so store entries instead of recompressing them.
    const zipBytes = zipSync(entries, { level: 0 });
    const zipBlob = new Blob([zipBytes as unknown as BlobPart], { type: "application/zip" });
    const filename = this.naming.zipName;
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

/** Fetch images, load the font and measure text once, then hand the shared inputs to a layout. */
async function prepareReport(
  attachments: ReportAttachment[],
  naming: ReportNaming,
  buildLayout: (images: Map<string, NormalizedImage>, measure: MeasureFn) => ReportPageLayout[],
  options?: PrepareReportOptions,
): Promise<PreparedDailyReport> {
  const abortController = new AbortController();
  if (options?.signal) {
    options.signal.addEventListener("abort", () => abortController.abort());
  }

  const normalizedImages = await fetchAllScreenshots(attachments, options);

  const fontBytes = await loadFontBytes(
    (res) =>
      `Could not load PDF font /fonts/NotoSans-Regular.ttf (${res.status} ${res.statusText})`,
  );
  await ensureFontFaceRegistered(fontBytes);

  let measure: MeasureFn = defaultMeasure;
  try {
    const { default: fontkit } = await import("@pdf-lib/fontkit");
    const parsedFont = (fontkit as any).create(fontBytes);
    if (parsedFont && typeof parsedFont.layout === "function") {
      // Sum of glyph advances without kerning: exactly what pdf-lib's drawText advances by.
      measure = (text: string, size: number) => {
        const { glyphs } = parsedFont.layout(text);
        let units = 0;
        for (const g of glyphs) units += g.advanceWidth;
        return (units / parsedFont.unitsPerEm) * size;
      };
    }
  } catch {
    measure = defaultMeasure;
  }

  return new PreparedDailyReportImpl(
    naming,
    buildLayout(normalizedImages, measure),
    normalizedImages,
    abortController,
    fontBytes,
  );
}

export function prepareDailyReport(
  report: DailyReport,
  options?: PrepareReportOptions,
): Promise<PreparedDailyReport> {
  const pad = (n: number) => String(n).padStart(2, "0");
  return prepareReport(
    [...(report.attachments || []), ...(report.trades?.flatMap((t) => t.attachments || []) || [])],
    {
      pdfTitle: `Daily Report · ${report.date}`,
      pdfName: `${report.date}-daily-report.pdf`,
      zipName: `${report.date}-daily-report.zip`,
      singlePngName: (n, page) =>
        `${report.date}-daily-report-${pad(n)}-${slugify(page.title)}.png`,
    },
    (images, measure) => buildReportLayout(report, images, measure),
    options,
  );
}

export function prepareTradeReport(
  report: TradeReport,
  options?: PrepareReportOptions,
): Promise<PreparedDailyReport> {
  const { trade } = report;
  const base = `${tradeReportDate(report)}-${slugify(trade.symbol)}-${trade.direction}-trade-report`;
  return prepareReport(
    trade.attachments || [],
    {
      pdfTitle: `Trade Report · ${trade.symbol} · ${tradeReportDate(report)}`,
      pdfName: `${base}.pdf`,
      zipName: `${base}.zip`,
      singlePngName: () => `${base}.png`,
    },
    (images, measure) => buildTradeReportLayout(report, images, measure),
    options,
  );
}
