import type {
  DailyReport,
  DailyReportTrade,
  ReportAttachment,
  ReportExecution,
  ReportPlaybookRule,
  ReportAiReview,
  ReportExcursions,
} from "./daily-report-types";

export const PAGE_WIDTH = 595.28; // Logical A4 points (72 pt / inch)
export const PAGE_HEIGHT = 841.89;
export const MARGIN_LEFT = 40;
export const MARGIN_RIGHT = 40;
export const USABLE_WIDTH = PAGE_WIDTH - MARGIN_LEFT - MARGIN_RIGHT; // 515.28 pt
export const MARGIN_TOP = 44;
export const MARGIN_BOTTOM = 44;
export const USABLE_HEIGHT = PAGE_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM; // 753.89 pt

// Editorial palette: parchment, navy, high-contrast ink, trader green/red
export const COLORS = {
  navyBrand: "#1b365d",
  navyAccent: "#24487a",
  pageBg: "#faf9f6",
  cardBg: "#ffffff",
  cardBorder: "#dedbcf",
  divider: "#e8e6dc",
  textMain: "#141413",
  textMuted: "#6b6a64",
  profitGreen: "#006300",
  profitBg: "#eef8ee",
  profitBorder: "#a3d9a3",
  lossRed: "#c33535",
  lossBg: "#fdf2f2",
  lossBorder: "#f1b8b8",
  neutralBg: "#f2f0e8",
  neutralBorder: "#dedbcf",
  gridline: "#e8e6dc",
  baseline: "#b8b4a6",
};

export interface RectItem {
  type: "rect";
  x: number;
  y: number;
  w: number;
  h: number;
  fill?: string;
  stroke?: string;
  lineWidth?: number;
  radius?: number;
}

export interface LineItem {
  type: "line";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stroke: string;
  lineWidth?: number;
  dash?: number[];
}

export interface TextItem {
  type: "text";
  x: number;
  y: number;
  text: string;
  size: number;
  bold?: boolean;
  color: string;
  align?: "left" | "center" | "right";
  maxWidth?: number;
}

export interface BadgeItem {
  type: "badge";
  x: number;
  y: number;
  text: string;
  size: number;
  color: string;
  bgColor: string;
  borderColor?: string;
  paddingX?: number;
  paddingY?: number;
}

export interface ChartPoint {
  t: string;
  cumNetPnl: number;
}

export interface ChartItem {
  type: "chart";
  x: number;
  y: number;
  w: number;
  h: number;
  points: ChartPoint[];
  title?: string;
  currency?: string;
}

export interface ImageItem {
  type: "image";
  x: number;
  y: number;
  w: number;
  h: number;
  bytes: Uint8Array;
  mime: string;
  name: string;
}

export type LayoutItem = RectItem | LineItem | TextItem | BadgeItem | ChartItem | ImageItem;

export interface ReportPageLayout {
  id: string;
  title: string;
  kind: "daily" | "trade" | "screenshot";
  tradeKey?: string;
  pageIndex: number; // 0-indexed
  items: LayoutItem[];
}

export interface NormalizedImage {
  bytes: Uint8Array;
  mime: string;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// Formatting Helpers
// ---------------------------------------------------------------------------

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "page"
  );
}

export function formatMoney(
  amount: number | null | undefined,
  currency = "USD",
  options: { signed?: boolean } = {},
): string {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return "–";

  const cur = (currency || "").trim().toUpperCase();

  // If mixed currencies (e.g. "MIXED" or contains comma)
  if (!cur || cur === "MIXED" || cur.includes(",")) {
    const sign = amount > 0 ? (options.signed ? "+" : "") : amount < 0 ? "-" : "";
    const abs = Math.abs(amount).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return `${sign}${abs} (Mixed)`;
  }

  const sign = amount > 0 ? (options.signed ? "+" : "") : amount < 0 ? "-" : "";
  const absAmount = Math.abs(amount);
  const isTiny = absAmount !== 0 && absAmount < 0.01;
  const fractionDigits = isTiny
    ? Math.min(8, Math.max(2, -Math.floor(Math.log10(absAmount)) + 2))
    : 2;

  // Try standard ISO currency formatting via Intl (e.g. USD, EUR, GBP, JPY)
  try {
    const formatter = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: cur,
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    });
    return `${sign}${formatter.format(absAmount)}`;
  } catch {
    // Fallback for non-ISO currency codes (e.g. USDT, USDC, BTC, ETH)
    const absStr = absAmount.toLocaleString("en-US", {
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    });
    return `${sign}${absStr} ${cur}`;
  }
}

export function formatPrecision(
  val: number | null | undefined,
  options: { signed?: boolean } = {},
): string {
  if (val === null || val === undefined || Number.isNaN(val)) return "–";
  if (val === 0) return "0";
  const abs = Math.abs(val);
  const sign = val > 0 ? (options.signed ? "+" : "") : val < 0 ? "-" : "";

  // Preserves platform round-trip Number precision (e.g. 17-digit normal and tiny exponential)
  const str = String(abs);
  if (str.includes("e") || str.includes("E")) {
    return `${sign}${str}`;
  }
  const parts = str.split(".");
  const intPart = parts[0]!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const formatted = parts.length > 1 ? `${intPart}.${parts[1]}` : intPart;
  return `${sign}${formatted}`;
}

export function formatNumber(
  val: number | null | undefined,
  decimals = 2,
  options: { signed?: boolean } = {},
): string {
  if (val === null || val === undefined || Number.isNaN(val)) return "–";
  const abs = Math.abs(val).toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  const sign = val > 0 ? (options.signed ? "+" : "") : val < 0 ? "-" : "";
  return `${sign}${abs}`;
}

export function formatPercent(val: number | null | undefined): string {
  if (val === null || val === undefined || Number.isNaN(val)) return "–";
  return `${(val * 100).toFixed(1)}%`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms) || ms < 0) return "–";
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "–";
  const cleaned = iso
    .replace("T", " ")
    .replace(/\.\d+Z?$/, "")
    .replace("Z", "");
  return cleaned;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function renderRating(rating: number | null): string {
  if (rating === null || rating === undefined || rating < 1) return "Unrated";
  const stars = Math.min(5, Math.max(1, Math.round(rating)));
  return `${"★".repeat(stars)}${"☆".repeat(5 - stars)} (${rating}/5)`;
}

// ---------------------------------------------------------------------------
// Text Measurement & Word Wrapping
// ---------------------------------------------------------------------------

export type MeasureFn = (text: string, size: number) => number;

export function defaultMeasure(text: string, size: number): number {
  let width = 0;
  for (const ch of text) {
    if ("ijl1 |.,:;!'\"()[]{}".includes(ch)) {
      width += size * 0.28;
    } else if ("mwMW@%#QO".includes(ch)) {
      width += size * 0.85;
    } else if (ch >= "A" && ch <= "Z") {
      width += size * 0.65;
    } else {
      width += size * 0.52;
    }
  }
  return width;
}

export function wrapText(
  text: string,
  maxWidth: number,
  size: number,
  measure: MeasureFn = defaultMeasure,
): string[] {
  if (!text) return [""];
  const lines: string[] = [];
  const paragraphs = text.split("\n");

  for (const para of paragraphs) {
    if (!para.trim()) {
      lines.push("");
      continue;
    }
    const words = para.split(/\s+/);
    let curLine = "";

    for (const word of words) {
      const candidate = curLine ? `${curLine} ${word}` : word;
      if (measure(candidate, size) <= maxWidth) {
        curLine = candidate;
      } else {
        if (curLine) {
          lines.push(curLine);
          curLine = "";
        }
        // Word itself exceeds maxWidth (long unbroken token)
        if (measure(word, size) > maxWidth) {
          let part = "";
          for (const char of word) {
            if (measure(part + char, size) > maxWidth && part) {
              lines.push(part);
              part = char;
            } else {
              part += char;
            }
          }
          curLine = part;
        } else {
          curLine = word;
        }
      }
    }
    if (curLine) lines.push(curLine);
  }

  return lines.length ? lines : [""];
}

// ---------------------------------------------------------------------------
// Headless Markdown Parser
// ---------------------------------------------------------------------------

export interface MarkdownBlock {
  type: "heading" | "paragraph" | "list" | "quote" | "divider" | "code" | "table";
  level?: number;
  text?: string;
  items?: { text: string; checked?: boolean; orderedNum?: number }[];
  headers?: string[];
  rows?: string[][];
}

export function parseMarkdown(src: string): MarkdownBlock[] {
  if (!src) return [];
  const lines = src.split(/\r?\n/);
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i]!;
    const trimmed = raw.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    // Horizontal Rule
    if (/^(---|___|\*\*\*)$/.test(trimmed)) {
      blocks.push({ type: "divider" });
      i++;
      continue;
    }

    // Heading (# to ######)
    const headingMatch = raw.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      blocks.push({
        type: "heading",
        level: headingMatch[1]!.length,
        text: headingMatch[2]!.trim(),
      });
      i++;
      continue;
    }

    // Code block
    if (trimmed.startsWith("```")) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith("```")) {
        codeLines.push(lines[i]!);
        i++;
      }
      if (i < lines.length) i++; // consume closing ```
      blocks.push({ type: "code", text: codeLines.join("\n") });
      continue;
    }

    // Blockquote
    if (raw.startsWith(">")) {
      const quoteLines: string[] = [];
      while (
        i < lines.length &&
        (lines[i]!.startsWith(">") || (lines[i]!.trim() && !lines[i]!.startsWith("#")))
      ) {
        quoteLines.push(lines[i]!.replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ type: "quote", text: quoteLines.join("\n") });
      continue;
    }

    // Markdown Table: line contains |
    if (trimmed.startsWith("|") && trimmed.endsWith("|") && lines[i + 1]?.includes("---")) {
      const parseRow = (line: string) =>
        line
          .slice(1, -1)
          .split("|")
          .map((c) => c.trim());
      const headers = parseRow(lines[i]!);
      i += 2; // skip header and divider
      const rows: string[][] = [];
      while (
        i < lines.length &&
        lines[i]!.trim().startsWith("|") &&
        lines[i]!.trim().endsWith("|")
      ) {
        rows.push(parseRow(lines[i]!));
        i++;
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }

    // Checklist or List item
    const taskMatch = raw.match(/^[-*]\s+\[([ xX])\]\s+(.+)$/);
    const bulletMatch = raw.match(/^[-*]\s+(.+)$/);
    const orderedMatch = raw.match(/^(\d+)\.\s+(.+)$/);

    if (taskMatch || bulletMatch || orderedMatch) {
      const listItems: { text: string; checked?: boolean; orderedNum?: number }[] = [];
      while (i < lines.length) {
        const line = lines[i]!;
        const tm = line.match(/^[-*]\s+\[([ xX])\]\s+(.+)$/);
        const bm = line.match(/^[-*]\s+(.+)$/);
        const om = line.match(/^(\d+)\.\s+(.+)$/);
        if (tm) {
          listItems.push({ text: tm[2]!.trim(), checked: tm[1]!.toLowerCase() === "x" });
          i++;
        } else if (bm) {
          listItems.push({ text: bm[1]!.trim() });
          i++;
        } else if (om) {
          listItems.push({ text: om[2]!.trim(), orderedNum: Number(om[1]) });
          i++;
        } else {
          break;
        }
      }
      blocks.push({ type: "list", items: listItems });
      continue;
    }

    // Regular Paragraph
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !lines[i]!.trim().startsWith("#") &&
      !lines[i]!.trim().startsWith("```") &&
      !lines[i]!.trim().startsWith(">") &&
      !lines[i]!.trim().startsWith("|") &&
      !lines[i]!.match(/^[-*]\s/) &&
      !lines[i]!.match(/^\d+\.\s/) &&
      !lines[i]!.match(/^(---|___|\*\*\*)$/)
    ) {
      paraLines.push(lines[i]!.trim());
      i++;
    }
    if (paraLines.length) {
      blocks.push({ type: "paragraph", text: paraLines.join(" ") });
    }
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Page Layout Builder
// ---------------------------------------------------------------------------

export class PageLayoutBuilder {
  pages: ReportPageLayout[] = [];
  currentPage!: ReportPageLayout;
  cursorY: number = MARGIN_TOP;
  maxY: number = PAGE_HEIGHT - MARGIN_BOTTOM;
  measure: MeasureFn;

  currentKind: "daily" | "trade" | "screenshot" = "daily";
  currentTradeKey?: string;
  baseTitle: string = "Daily Report";

  constructor(measure: MeasureFn = defaultMeasure) {
    this.measure = measure;
  }

  startNewPage(
    kind: "daily" | "trade" | "screenshot",
    title: string,
    tradeKey?: string,
    idOverride?: string,
  ): ReportPageLayout {
    this.currentKind = kind;
    this.currentTradeKey = tradeKey;
    const cleanBase = title.replace(/\s*\(Continued\).*$/, "").trim();
    if (cleanBase) {
      this.baseTitle = cleanBase;
    }

    const pageIndex = this.pages.length;
    const pageId =
      idOverride ?? (tradeKey ? `trade-${tradeKey}-p${pageIndex + 1}` : `daily-p${pageIndex + 1}`);

    const page: ReportPageLayout = {
      id: pageId,
      title,
      kind,
      tradeKey,
      pageIndex,
      items: [],
    };

    // Draw top brand bar (navy accent, 3.5 pt)
    page.items.push({
      type: "rect",
      x: 0,
      y: 0,
      w: PAGE_WIDTH,
      h: 3.5,
      fill: COLORS.navyBrand,
    });

    this.pages.push(page);
    this.currentPage = page;
    this.cursorY = MARGIN_TOP + 8;
    return page;
  }

  ensureSpace(neededHeight: number, continuationContext = ""): void {
    if (this.cursorY + neededHeight > this.maxY) {
      const cleanBase = this.baseTitle.replace(/\s*\(Continued\).*$/, "").trim();
      const continuationTitle = `${cleanBase} (Continued)${continuationContext ? ` · ${continuationContext}` : ""}`;
      this.startNewPage(this.currentKind, continuationTitle, this.currentTradeKey);
      this.addContinuationHeader(continuationTitle);
    }
  }

  addContinuationHeader(title: string): void {
    this.currentPage.items.push({
      type: "text",
      x: MARGIN_LEFT,
      y: this.cursorY,
      text: title,
      size: 9,
      bold: true,
      color: COLORS.navyBrand,
    });
    this.cursorY += 12;
    this.currentPage.items.push({
      type: "line",
      x1: MARGIN_LEFT,
      y1: this.cursorY,
      x2: MARGIN_LEFT + USABLE_WIDTH,
      y2: this.cursorY,
      stroke: COLORS.divider,
      lineWidth: 0.5,
    });
    this.cursorY += 10;
  }

  addText(
    text: string,
    size: number,
    color = COLORS.textMain,
    options: { bold?: boolean; align?: "left" | "center" | "right"; maxWidth?: number } = {},
  ): void {
    const wrapped = wrapText(text, options.maxWidth ?? USABLE_WIDTH, size, this.measure);
    const lineHeight = size * 1.35;

    for (const line of wrapped) {
      this.ensureSpace(lineHeight);
      this.currentPage.items.push({
        type: "text",
        x: MARGIN_LEFT,
        y: this.cursorY,
        text: line,
        size,
        bold: options.bold,
        color,
        align: options.align,
        maxWidth: options.maxWidth ?? USABLE_WIDTH,
      });
      this.cursorY += lineHeight;
    }
  }

  addSectionHeading(title: string, subtitle?: string): void {
    // Avoid orphan headers: heading + at least 2 lines of body (approx 65 pt)
    this.ensureSpace(65, title);

    this.cursorY += 6;
    this.currentPage.items.push({
      type: "text",
      x: MARGIN_LEFT,
      y: this.cursorY,
      text: title,
      size: 12,
      bold: true,
      color: COLORS.navyBrand,
    });
    this.cursorY += 15;

    if (subtitle) {
      this.currentPage.items.push({
        type: "text",
        x: MARGIN_LEFT,
        y: this.cursorY,
        text: subtitle,
        size: 8.5,
        color: COLORS.textMuted,
      });
      this.cursorY += 11;
    }

    this.currentPage.items.push({
      type: "line",
      x1: MARGIN_LEFT,
      y1: this.cursorY,
      x2: MARGIN_LEFT + USABLE_WIDTH,
      y2: this.cursorY,
      stroke: COLORS.cardBorder,
      lineWidth: 0.75,
    });
    this.cursorY += 8;
  }

  addCard(
    x: number,
    y: number,
    w: number,
    h: number,
    fill = COLORS.cardBg,
    stroke = COLORS.cardBorder,
  ): void {
    this.currentPage.items.push({
      type: "rect",
      x,
      y,
      w,
      h,
      fill,
      stroke,
      lineWidth: 0.75,
      radius: 4,
    });
  }

  addTable(
    headers: string[],
    rows: string[][],
    colWidths: number[],
    aligns: ("left" | "right" | "center")[] = [],
    tableName = "Table",
  ): void {
    const headerHeight = 19;

    const drawHeader = () => {
      this.currentPage.items.push({
        type: "rect",
        x: MARGIN_LEFT,
        y: this.cursorY,
        w: USABLE_WIDTH,
        h: headerHeight,
        fill: COLORS.neutralBg,
        stroke: COLORS.cardBorder,
        lineWidth: 0.5,
      });
      let cx = MARGIN_LEFT;
      headers.forEach((h, idx) => {
        const w = colWidths[idx] ?? 80;
        const align = aligns[idx] ?? "left";
        const tx = align === "right" ? cx + w - 4 : align === "center" ? cx + w / 2 : cx + 4;
        this.currentPage.items.push({
          type: "text",
          x: tx,
          y: this.cursorY + 4,
          text: h,
          size: 7.5,
          bold: true,
          color: COLORS.navyBrand,
          align,
          maxWidth: w - 6,
        });
        cx += w;
      });
      this.cursorY += headerHeight;
    };

    // Ensure space for at least header + initial row space (approx 36 pt)
    this.ensureSpace(headerHeight + 25, tableName);
    drawHeader();

    rows.forEach((row, rIdx) => {
      // Wrap each cell by its column width
      const wrappedCells = row.map((cell, cIdx) => {
        const cellW = (colWidths[cIdx] ?? 80) - 8;
        return wrapText(cell, cellW, 7.5, this.measure);
      });
      const maxLines = Math.max(1, ...wrappedCells.map((c) => c.length));

      let lineOffset = 0;
      while (lineOffset < maxLines) {
        let availH = this.maxY - this.cursorY;
        if (availH < 18) {
          this.startNewPage(
            this.currentKind,
            `${this.baseTitle} (Continued) · ${tableName}`,
            this.currentTradeKey,
          );
          this.addContinuationHeader(`${tableName} (Continued)`);
          drawHeader();
          availH = this.maxY - this.cursorY;
        }

        const maxChunkLines = Math.max(1, Math.floor((availH - 6) / 11));
        const chunkLines = Math.min(maxLines - lineOffset, maxChunkLines);
        const chunkHeight = chunkLines * 11 + 6;

        const isEven = rIdx % 2 === 0;
        if (isEven) {
          this.currentPage.items.push({
            type: "rect",
            x: MARGIN_LEFT,
            y: this.cursorY,
            w: USABLE_WIDTH,
            h: chunkHeight,
            fill: "#fcfbfa",
          });
        }

        this.currentPage.items.push({
          type: "line",
          x1: MARGIN_LEFT,
          y1: this.cursorY + chunkHeight,
          x2: MARGIN_LEFT + USABLE_WIDTH,
          y2: this.cursorY + chunkHeight,
          stroke: COLORS.divider,
          lineWidth: 0.4,
        });

        let cx = MARGIN_LEFT;
        wrappedCells.forEach((cellLines, cIdx) => {
          const w = colWidths[cIdx] ?? 80;
          const align = aligns[cIdx] ?? "left";
          const tx = align === "right" ? cx + w - 4 : align === "center" ? cx + w / 2 : cx + 4;

          for (let l = 0; l < chunkLines; l++) {
            const lineIdx = lineOffset + l;
            if (lineIdx < cellLines.length) {
              const lineText = cellLines[lineIdx]!;
              this.currentPage.items.push({
                type: "text",
                x: tx,
                y: this.cursorY + 3.5 + l * 11,
                text: lineText,
                size: 7.5,
                color: COLORS.textMain,
                align,
                maxWidth: w - 6,
              });
            }
          }
          cx += w;
        });

        this.cursorY += chunkHeight;
        lineOffset += chunkLines;
      }
    });

    this.cursorY += 8;
  }

  addMarkdown(markdownText: string): void {
    if (!markdownText?.trim()) return;
    const blocks = parseMarkdown(markdownText);

    for (const block of blocks) {
      if (block.type === "divider") {
        this.ensureSpace(14);
        this.currentPage.items.push({
          type: "line",
          x1: MARGIN_LEFT,
          y1: this.cursorY + 6,
          x2: MARGIN_LEFT + USABLE_WIDTH,
          y2: this.cursorY + 6,
          stroke: COLORS.divider,
          lineWidth: 0.75,
        });
        this.cursorY += 14;
      } else if (block.type === "heading") {
        const size = block.level === 1 ? 13 : block.level === 2 ? 11 : 9.5;
        // Reserve space for heading + at least 2 lines of body space (approx 45 pt) to prevent orphans
        this.ensureSpace(size * 1.5 + 45, block.text);
        this.cursorY += 4;
        this.addText(block.text ?? "", size, COLORS.navyBrand, { bold: true });
        this.cursorY += 3;
      } else if (block.type === "paragraph") {
        this.addText(block.text ?? "", 8.5, COLORS.textMain);
        this.cursorY += 4;
      } else if (block.type === "list") {
        for (const item of block.items ?? []) {
          this.ensureSpace(14);
          let prefix = "• ";
          if (item.checked !== undefined) {
            prefix = item.checked ? "[✓] " : "[ ] ";
          } else if (item.orderedNum) {
            prefix = `${item.orderedNum}. `;
          }

          const fullLine = `${prefix}${item.text}`;
          const wrapped = wrapText(fullLine, USABLE_WIDTH - 12, 8.5, this.measure);
          wrapped.forEach((line, lIdx) => {
            this.ensureSpace(12);
            this.currentPage.items.push({
              type: "text",
              x: MARGIN_LEFT + (lIdx === 0 ? 6 : 18),
              y: this.cursorY,
              text: line,
              size: 8.5,
              color: item.checked ? COLORS.profitGreen : COLORS.textMain,
              bold: item.checked,
              maxWidth: USABLE_WIDTH - 18,
            });
            this.cursorY += 12;
          });
        }
        this.cursorY += 4;
      } else if (block.type === "quote") {
        const wrapped = wrapText(block.text ?? "", USABLE_WIDTH - 24, 8.5, this.measure);
        let chunkStart = this.cursorY;
        let chunkCount = 0;

        for (let qIdx = 0; qIdx < wrapped.length; qIdx++) {
          const line = wrapped[qIdx]!;
          if (this.cursorY + 12 > this.maxY) {
            // Close accent line on current page
            if (chunkCount > 0) {
              this.currentPage.items.push({
                type: "line",
                x1: MARGIN_LEFT + 4,
                y1: chunkStart,
                x2: MARGIN_LEFT + 4,
                y2: chunkStart + chunkCount * 12 + 2,
                stroke: COLORS.navyAccent,
                lineWidth: 2,
              });
            }
            this.ensureSpace(20, "Quote");
            chunkStart = this.cursorY;
            chunkCount = 0;
          }

          this.currentPage.items.push({
            type: "text",
            x: MARGIN_LEFT + 14,
            y: this.cursorY + 2,
            text: line,
            size: 8.5,
            color: COLORS.textMuted,
            maxWidth: USABLE_WIDTH - 24,
          });
          this.cursorY += 12;
          chunkCount++;
        }

        if (chunkCount > 0) {
          this.currentPage.items.push({
            type: "line",
            x1: MARGIN_LEFT + 4,
            y1: chunkStart,
            x2: MARGIN_LEFT + 4,
            y2: chunkStart + chunkCount * 12 + 2,
            stroke: COLORS.navyAccent,
            lineWidth: 2,
          });
        }
        this.cursorY += 6;
      } else if (block.type === "code") {
        const rawLines = (block.text ?? "").split(/\r?\n/);
        // Wrap each code line to fit within USABLE_WIDTH - 16
        const wrappedCodeLines = rawLines.flatMap((line) =>
          wrapText(line || " ", USABLE_WIDTH - 16, 8, this.measure),
        );

        let curIdx = 0;
        while (curIdx < wrappedCodeLines.length) {
          let availH = this.maxY - this.cursorY - 12;
          if (availH < 28) {
            this.ensureSpace(35, "Code");
            availH = this.maxY - this.cursorY - 12;
          }

          const linesInChunk = Math.max(
            1,
            Math.min(wrappedCodeLines.length - curIdx, Math.floor((availH - 8) / 11)),
          );
          const chunk = wrappedCodeLines.slice(curIdx, curIdx + linesInChunk);
          const chunkH = chunk.length * 11 + 8;

          // Bounded background rectangle per page
          this.currentPage.items.push({
            type: "rect",
            x: MARGIN_LEFT,
            y: this.cursorY,
            w: USABLE_WIDTH,
            h: chunkH,
            fill: COLORS.neutralBg,
            stroke: COLORS.neutralBorder,
            lineWidth: 0.5,
          });

          const textStartY = this.cursorY + 4;
          chunk.forEach((codeLine, idx) => {
            this.currentPage.items.push({
              type: "text",
              x: MARGIN_LEFT + 8,
              y: textStartY + idx * 11,
              text: codeLine,
              size: 8,
              color: COLORS.textMain,
              maxWidth: USABLE_WIDTH - 16,
            });
          });

          this.cursorY += chunkH + 4;
          curIdx += linesInChunk;
        }
        this.cursorY += 4;
      } else if (block.type === "table" && block.headers && block.rows) {
        const colW = USABLE_WIDTH / block.headers.length;
        const colWidths = block.headers.map(() => colW);
        this.addTable(block.headers, block.rows, colWidths, [], "Note Table");
      }
    }
  }

  finalizeFooters(reportDate: string): void {
    const total = this.pages.length;
    this.pages.forEach((page, idx) => {
      // Divider above footer
      page.items.push({
        type: "line",
        x1: MARGIN_LEFT,
        y1: PAGE_HEIGHT - 32,
        x2: MARGIN_LEFT + USABLE_WIDTH,
        y2: PAGE_HEIGHT - 32,
        stroke: COLORS.divider,
        lineWidth: 0.5,
      });

      // Left footer: Report date & brand
      page.items.push({
        type: "text",
        x: MARGIN_LEFT,
        y: PAGE_HEIGHT - 24,
        text: `Sumi Daily Report  |  ${reportDate}`,
        size: 7.5,
        color: COLORS.textMuted,
      });

      // Right footer: Page X of Y
      page.items.push({
        type: "text",
        x: MARGIN_LEFT + USABLE_WIDTH,
        y: PAGE_HEIGHT - 24,
        text: `Page ${idx + 1} of ${total}`,
        size: 7.5,
        bold: true,
        color: COLORS.textMuted,
        align: "right",
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Main Document Layout Generator
// ---------------------------------------------------------------------------

export function buildReportLayout(
  report: DailyReport,
  normalizedImages: Map<string, NormalizedImage>,
  measure: MeasureFn = defaultMeasure,
): ReportPageLayout[] {
  const b = new PageLayoutBuilder(measure);

  // =========================================================================
  // SECTION 1: DAILY OVERVIEW
  // =========================================================================
  b.startNewPage("daily", `Daily overview · ${report.date}`, undefined, "daily-overview");

  // Top Title & Meta
  b.currentPage.items.push({
    type: "text",
    x: MARGIN_LEFT,
    y: b.cursorY,
    text: "DAILY JOURNAL REPORT",
    size: 16,
    bold: true,
    color: COLORS.navyBrand,
  });
  b.cursorY += 19;

  b.currentPage.items.push({
    type: "text",
    x: MARGIN_LEFT,
    y: b.cursorY,
    text: `Date: ${report.date}   |   Exported: ${formatDate(report.exportedAt)}   |   Timezone: ${report.timeZone}`,
    size: 8.5,
    color: COLORS.textMuted,
  });
  b.cursorY += 14;

  // Scope box
  const curText =
    report.scope.currencies.length > 1
      ? `${report.scope.currencies.join(", ")} (Mixed - not converted)`
      : (report.scope.currencies[0] ?? "USD");
  const accText = report.scope.accountNames.length
    ? report.scope.accountNames.join(", ")
    : "All accounts";

  b.addCard(MARGIN_LEFT, b.cursorY, USABLE_WIDTH, 34, COLORS.neutralBg, COLORS.neutralBorder);
  b.currentPage.items.push({
    type: "text",
    x: MARGIN_LEFT + 6,
    y: b.cursorY + 4,
    text: `Scope: ${report.scope.label || "All trades"}   •   Accounts: ${accText}`,
    size: 8,
    bold: true,
    color: COLORS.navyBrand,
    maxWidth: USABLE_WIDTH - 12,
  });
  b.currentPage.items.push({
    type: "text",
    x: MARGIN_LEFT + 6,
    y: b.cursorY + 18,
    text: `Currencies: ${curText}   •   Note: Day note is global across accounts for this date.`,
    size: 7.5,
    color: COLORS.textMuted,
    maxWidth: USABLE_WIDTH - 12,
  });
  b.cursorY += 40;

  // 4 Primary KPI Cards
  const m = report.metrics;
  const isMixedCurrencies = report.scope.currencies.length > 1;
  const overviewCurrency = isMixedCurrencies ? "MIXED" : (report.scope.currencies[0] ?? "USD");
  const cardW = (USABLE_WIDTH - 18) / 4;
  const cardH = 46;

  // Net P&L Card
  const pnlColor =
    m.netPnl > 0 ? COLORS.profitGreen : m.netPnl < 0 ? COLORS.lossRed : COLORS.textMain;
  const pnlBg = m.netPnl > 0 ? COLORS.profitBg : m.netPnl < 0 ? COLORS.lossBg : COLORS.cardBg;
  const pnlBorder =
    m.netPnl > 0 ? COLORS.profitBorder : m.netPnl < 0 ? COLORS.lossBorder : COLORS.cardBorder;
  const pnlBadge = m.netPnl > 0 ? "PROFIT" : m.netPnl < 0 ? "LOSS" : "BREAKEVEN";

  b.addCard(MARGIN_LEFT, b.cursorY, cardW, cardH, pnlBg, pnlBorder);
  b.currentPage.items.push({
    type: "text",
    x: MARGIN_LEFT + 6,
    y: b.cursorY + 4,
    text: "NET P&L",
    size: 7.5,
    bold: true,
    color: COLORS.textMuted,
  });
  b.currentPage.items.push({
    type: "text",
    x: MARGIN_LEFT + 6,
    y: b.cursorY + 16,
    text: formatMoney(m.netPnl, overviewCurrency, { signed: true }),
    size: 11,
    bold: true,
    color: pnlColor,
  });
  b.currentPage.items.push({
    type: "badge",
    x: MARGIN_LEFT + cardW - 46,
    y: b.cursorY + 4,
    text: pnlBadge,
    size: 6.5,
    color: pnlColor,
    bgColor: pnlBg,
    borderColor: pnlBorder,
  });

  // Trades Card
  b.addCard(MARGIN_LEFT + cardW + 6, b.cursorY, cardW, cardH);
  b.currentPage.items.push({
    type: "text",
    x: MARGIN_LEFT + cardW + 12,
    y: b.cursorY + 4,
    text: "CLOSED TRADES",
    size: 7.5,
    bold: true,
    color: COLORS.textMuted,
  });
  b.currentPage.items.push({
    type: "text",
    x: MARGIN_LEFT + cardW + 12,
    y: b.cursorY + 16,
    text: `${m.closedTrades} Trades`,
    size: 11,
    bold: true,
    color: COLORS.textMain,
  });
  b.currentPage.items.push({
    type: "text",
    x: MARGIN_LEFT + cardW + 12,
    y: b.cursorY + 32,
    text: `${m.wins}W · ${m.losses}L · ${m.breakevens}BE`,
    size: 7.5,
    color: COLORS.textMuted,
  });

  // Winrate Card
  b.addCard(MARGIN_LEFT + (cardW + 6) * 2, b.cursorY, cardW, cardH);
  b.currentPage.items.push({
    type: "text",
    x: MARGIN_LEFT + (cardW + 6) * 2 + 6,
    y: b.cursorY + 4,
    text: "WIN RATE",
    size: 7.5,
    bold: true,
    color: COLORS.textMuted,
  });
  b.currentPage.items.push({
    type: "text",
    x: MARGIN_LEFT + (cardW + 6) * 2 + 6,
    y: b.cursorY + 16,
    text: formatPercent(m.winRate),
    size: 11,
    bold: true,
    color: COLORS.textMain,
  });
  b.currentPage.items.push({
    type: "text",
    x: MARGIN_LEFT + (cardW + 6) * 2 + 6,
    y: b.cursorY + 32,
    text: `Win/Loss: ${formatNumber(m.avgWinLossRatio)}`,
    size: 7.5,
    color: COLORS.textMuted,
  });

  // Profit Factor Card
  const pfDisplay = report.profitFactorIsInfinite ? "∞ (Infinite)" : formatNumber(m.profitFactor);
  b.addCard(MARGIN_LEFT + (cardW + 6) * 3, b.cursorY, cardW, cardH);
  b.currentPage.items.push({
    type: "text",
    x: MARGIN_LEFT + (cardW + 6) * 3 + 6,
    y: b.cursorY + 4,
    text: "PROFIT FACTOR",
    size: 7.5,
    bold: true,
    color: COLORS.textMuted,
  });
  b.currentPage.items.push({
    type: "text",
    x: MARGIN_LEFT + (cardW + 6) * 3 + 6,
    y: b.cursorY + 16,
    text: pfDisplay,
    size: 11,
    bold: true,
    color: COLORS.textMain,
  });
  b.currentPage.items.push({
    type: "text",
    x: MARGIN_LEFT + (cardW + 6) * 3 + 6,
    y: b.cursorY + 32,
    text: `Expectancy: ${formatMoney(m.expectancy, overviewCurrency)}`,
    size: 7.5,
    color: COLORS.textMuted,
  });

  b.cursorY += cardH + 8;

  // Complete Detailed Metrics Table (All 26 TradeMetrics fields)
  const detailRows = [
    [
      `Gross P&L: ${formatMoney(m.grossPnl, overviewCurrency)}`,
      `Total Fees: ${formatMoney(m.fees, overviewCurrency)}`,
      `Total Volume: ${formatPrecision(m.totalVolume)}`,
      `Trading Days: ${m.tradingDays}`,
    ],
    [
      `Avg Win: ${formatMoney(m.avgWin, overviewCurrency)}`,
      `Avg Loss: ${formatMoney(m.avgLoss, overviewCurrency)}`,
      `Largest Win: ${formatMoney(m.largestWin, overviewCurrency)}`,
      `Largest Loss: ${formatMoney(m.largestLoss, overviewCurrency)}`,
    ],
    [
      `Max Win Streak: W${m.maxWinStreak}`,
      `Max Loss Streak: L${m.maxLossStreak}`,
      `Current Streak: ${m.currentStreak > 0 ? `+${m.currentStreak}` : m.currentStreak}`,
      `Avg Duration: ${formatDuration(m.avgDurationMs)}`,
    ],
    [
      `Max Drawdown: ${formatMoney(m.maxDrawdown, overviewCurrency)}`,
      `Max DD %: ${formatPercent(m.maxDrawdownPct)}`,
      `Recovery Factor: ${formatNumber(m.recoveryFactor)}`,
      `Profit Conc.: ${formatPercent(m.profitConcentration)}`,
    ],
    [
      `Avg Realized R: ${m.avgRealizedR !== null ? `${formatNumber(m.avgRealizedR, 2, { signed: true })}R` : "–"}`,
      `Trades with Risk: ${m.tradesWithRisk}`,
      `Day Win Rate: ${formatPercent(m.dayWinRate)}`,
      `Open Trades: ${m.openTrades}`,
    ],
  ];

  const col4W = USABLE_WIDTH / 4;
  b.addTable(
    ["Financial Metrics", "Averages & Bounds", "Streaks & Holding", "Risk & Drawdown"],
    detailRows,
    [col4W, col4W, col4W, col4W],
  );

  // Intraday Equity Progression Chart
  b.ensureSpace(125, "Intraday Equity Curve");
  b.currentPage.items.push({
    type: "chart",
    x: MARGIN_LEFT,
    y: b.cursorY,
    w: USABLE_WIDTH,
    h: 95,
    points: report.intraday,
    title: "Intraday Equity Progression",
    currency: overviewCurrency,
  });
  b.cursorY += 105;

  // Document Attachments List (PDFs & non-images)
  const dayDocAttachments = report.attachments.filter((a) => !a.mime.startsWith("image/"));
  if (dayDocAttachments.length > 0) {
    b.addSectionHeading(`Attached Documents (${dayDocAttachments.length})`);
    const docRows = dayDocAttachments.map((a) => [
      a.name,
      a.mime,
      formatFileSize(a.size),
      formatDate(a.createdAt),
      "Listed metadata only",
    ]);
    const colDocW = [
      USABLE_WIDTH * 0.4,
      USABLE_WIDTH * 0.2,
      USABLE_WIDTH * 0.15,
      USABLE_WIDTH * 0.25,
    ];
    b.addTable(["Document Name", "Format", "Size", "Date Added"], docRows, colDocW, [
      "left",
      "left",
      "right",
      "right",
    ]);
  }

  // Written Daily Reflection & Notes (Flows to continuation pages if long)
  b.addSectionHeading(
    "Daily Reflection & Notes",
    report.noteUpdatedAt ? `Last saved: ${formatDate(report.noteUpdatedAt)}` : undefined,
  );
  if (report.note?.trim()) {
    b.addMarkdown(report.note);
  } else {
    b.addText("No daily reflection notes recorded for this date.", 8.5, COLORS.textMuted);
    b.cursorY += 8;
  }

  // Dedicated Day Screenshot Pages
  const dayImageAttachments = report.attachments.filter((a) => a.mime.startsWith("image/"));
  for (const imgAtt of dayImageAttachments) {
    const norm = normalizedImages.get(imgAtt.id);
    if (norm) {
      b.startNewPage(
        "screenshot",
        `Screenshot: ${imgAtt.name} (Day)`,
        undefined,
        `daily-screenshot-${imgAtt.id}`,
      );
      b.addSectionHeading(`Day Screenshot · ${imgAtt.name}`);
      b.currentPage.items.push({
        type: "text",
        x: MARGIN_LEFT,
        y: b.cursorY,
        text: `Size: ${formatFileSize(imgAtt.size)}   •   Format: ${imgAtt.mime}   •   Uploaded: ${formatDate(imgAtt.createdAt)}`,
        size: 8,
        color: COLORS.textMuted,
      });
      b.cursorY += 14;

      // Usable image area
      const maxImgW = USABLE_WIDTH;
      const maxImgH = PAGE_HEIGHT - b.cursorY - MARGIN_BOTTOM - 25;
      const scale = Math.min(maxImgW / norm.width, maxImgH / norm.height, 1);
      const imgW = norm.width * scale;
      const imgH = norm.height * scale;
      const imgX = MARGIN_LEFT + (USABLE_WIDTH - imgW) / 2;
      const imgY = b.cursorY + (maxImgH - imgH) / 2;

      b.currentPage.items.push({
        type: "image",
        x: imgX,
        y: imgY,
        w: imgW,
        h: imgH,
        bytes: norm.bytes,
        mime: norm.mime,
        name: imgAtt.name,
      });
      b.cursorY = imgY + imgH + 8;

      const captionText = `Figure: ${imgAtt.name} (${norm.width} × ${norm.height} px, aspect-fit upright)`;
      const wrappedCaption = wrapText(captionText, USABLE_WIDTH, 7.5, b.measure);
      for (const line of wrappedCaption) {
        b.currentPage.items.push({
          type: "text",
          x: PAGE_WIDTH / 2,
          y: b.cursorY,
          text: line,
          size: 7.5,
          color: COLORS.textMuted,
          align: "center",
          maxWidth: USABLE_WIDTH,
        });
        b.cursorY += 10;
      }
    }
  }

  // =========================================================================
  // SECTION 2: INDIVIDUAL TRADES
  // =========================================================================
  for (let tIdx = 0; tIdx < report.trades.length; tIdx++) {
    const trade = report.trades[tIdx]!;
    const tradeTitle = `Trade ${trade.symbol} (${trade.status.toUpperCase()})`;
    b.startNewPage("trade", tradeTitle, trade.key, `trade-${trade.key}-p1`);

    // Top trade identity bar
    const tradePnlColor =
      trade.netPnl > 0 ? COLORS.profitGreen : trade.netPnl < 0 ? COLORS.lossRed : COLORS.textMain;
    const tradeStatusBg =
      trade.status === "win"
        ? COLORS.profitBg
        : trade.status === "loss"
          ? COLORS.lossBg
          : COLORS.neutralBg;
    const tradeStatusBorder =
      trade.status === "win"
        ? COLORS.profitBorder
        : trade.status === "loss"
          ? COLORS.lossBorder
          : COLORS.neutralBorder;

    b.currentPage.items.push({
      type: "text",
      x: MARGIN_LEFT,
      y: b.cursorY,
      text: `${trade.symbol} · ${trade.direction.toUpperCase()}`,
      size: 15,
      bold: true,
      color: COLORS.navyBrand,
    });

    b.currentPage.items.push({
      type: "badge",
      x: MARGIN_LEFT + 220,
      y: b.cursorY - 2,
      text: trade.status.toUpperCase(),
      size: 8,
      color: tradePnlColor,
      bgColor: tradeStatusBg,
      borderColor: tradeStatusBorder,
    });

    b.currentPage.items.push({
      type: "text",
      x: MARGIN_LEFT + USABLE_WIDTH,
      y: b.cursorY,
      text: formatMoney(trade.netPnl, trade.currency, { signed: true }),
      size: 14,
      bold: true,
      color: tradePnlColor,
      align: "right",
    });
    b.cursorY += 19;

    b.currentPage.items.push({
      type: "text",
      x: MARGIN_LEFT,
      y: b.cursorY,
      text: `Account: ${trade.accountName} (${trade.currency})   •   Asset: ${trade.assetClass ?? "Generic"}   •   Rating: ${renderRating(trade.rating)}   •   Reviewed: ${trade.reviewedAt ? `Yes (${formatDate(trade.reviewedAt)})` : "No"}`,
      size: 8,
      color: COLORS.textMuted,
    });
    b.cursorY += 12;

    b.currentPage.items.push({
      type: "text",
      x: MARGIN_LEFT,
      y: b.cursorY,
      text: `Opened: ${formatDate(trade.openedAt)}   •   Closed: ${formatDate(trade.closedAt)}   •   Duration: ${formatDuration(trade.durationMs)}`,
      size: 8,
      color: COLORS.textMuted,
    });
    b.cursorY += 15;

    // Financial & Risk Grid
    const returnPct = trade.netReturnOnEntry !== null ? formatPercent(trade.netReturnOnEntry) : "–";
    const targetHitText =
      trade.targetHit === "profit_target"
        ? "Profit Target Hit"
        : trade.targetHit === "stop_loss"
          ? "Stop Loss Hit"
          : "– / Discretionary";

    const tradeOverviewRows = [
      [
        `Gross P&L: ${formatMoney(trade.grossPnl, trade.currency)}`,
        `Fees: ${formatMoney(trade.fees, trade.currency)}`,
        `Quantity: ${formatPrecision(trade.quantity)}`,
        `Multiplier: ${formatPrecision(trade.contractMultiplier)}`,
      ],
      [
        `Avg Entry: ${formatPrecision(trade.avgEntry)}`,
        `Avg Exit: ${formatPrecision(trade.avgExit)}`,
        `Return on Entry: ${returnPct}`,
        `Open Qty: ${formatPrecision(trade.openQuantity)}`,
      ],
      [
        `Stop Loss: ${formatPrecision(trade.stopLoss)}`,
        `Profit Target: ${formatPrecision(trade.profitTarget)}`,
        `Risk Amount: ${formatMoney(trade.riskAmount, trade.currency)}`,
        `Target Outcome: ${targetHitText}`,
      ],
      [
        `Planned R: ${trade.plannedR !== null ? `${formatNumber(trade.plannedR, 2)}R` : "–"}`,
        `Realized R: ${trade.realizedR !== null ? `${formatNumber(trade.realizedR, 2, { signed: true })}R` : "–"}`,
        `Currency: ${trade.currency}`,
        `Trade Status: ${trade.status.toUpperCase()}`,
      ],
    ];
    b.addTable(
      ["Executions & Fees", "Price & Notional", "Risk Boundaries", "R & Adherence"],
      tradeOverviewRows,
      [col4W, col4W, col4W, col4W],
    );

    // Tags & Mistakes
    const hasTags = trade.tags && trade.tags.length > 0;
    const hasMistakes = trade.mistakes && trade.mistakes.length > 0;
    if (hasTags || hasMistakes) {
      b.ensureSpace(18);
      let tagLine = "";
      if (hasTags) tagLine += `Tags: [${trade.tags.join("]  [")}]`;
      if (hasMistakes) {
        if (tagLine) tagLine += "     ";
        tagLine += `Mistakes: [${trade.mistakes.join("]  [")}]`;
      }
      b.addText(tagLine, 8, hasMistakes ? COLORS.lossRed : COLORS.navyBrand, { bold: true });
      b.cursorY += 4;
    }

    // Playbook & Strategy Rules
    if (trade.playbook) {
      b.addSectionHeading(
        `Strategy: ${trade.playbook.name}`,
        trade.playbook.description || undefined,
      );
      if (trade.playbook.rules && trade.playbook.rules.length > 0) {
        const ruleRows = trade.playbook.rules.map((r) => {
          const status =
            r.followed === true ? "✓ Followed" : r.followed === false ? "✗ Broken" : "— Unassessed";
          return [r.rule, status];
        });
        b.addTable(
          ["Strategy Rule Checklist", "Followed / Status"],
          ruleRows,
          [USABLE_WIDTH * 0.75, USABLE_WIDTH * 0.25],
          ["left", "center"],
          "Rules",
        );
      }
    }

    // Excursions (MAE / MFE)
    if (trade.excursions) {
      b.addSectionHeading("Excursion Analysis (MAE / MFE)");
      const exc = trade.excursions;
      const excRows = [
        [
          `Max Adverse Excursion (MAE): ${formatMoney(exc.mae, trade.currency)}`,
          `Max Favorable Excursion (MFE): ${formatMoney(exc.mfe, trade.currency)}`,
        ],
        [
          `Sampled: ${exc.sampledBars} bars (${exc.resolution})`,
          `Provider: ${exc.provider}   •   Fetched: ${formatDate(exc.fetchedAt)}`,
        ],
      ];
      b.addTable(["Adverse & Favorable Draw", "Market Data Sampling"], excRows, [
        USABLE_WIDTH * 0.5,
        USABLE_WIDTH * 0.5,
      ]);
    }

    // Running P&L Progression (if any)
    if (trade.runningPnl && trade.runningPnl.length > 0) {
      b.ensureSpace(90, "Trade Running P&L");
      b.currentPage.items.push({
        type: "chart",
        x: MARGIN_LEFT,
        y: b.cursorY,
        w: USABLE_WIDTH,
        h: 70,
        points: trade.runningPnl,
        title: `Running P&L Progression · ${trade.symbol}`,
        currency: trade.currency,
      });
      b.cursorY += 80;
    }

    // Executions / Fills Table (Repeated table headers on continuation)
    if (trade.executions && trade.executions.length > 0) {
      b.addSectionHeading(`Executions & Fills (${trade.executions.length})`);
      const execRows = trade.executions.map((e) => [
        formatDate(e.executedAt),
        e.side.toUpperCase(),
        formatPrecision(e.quantity),
        formatPrecision(e.price),
        formatMoney(e.fee, trade.currency),
        e.source || "Broker",
      ]);
      const colExecW = [
        USABLE_WIDTH * 0.28,
        USABLE_WIDTH * 0.12,
        USABLE_WIDTH * 0.15,
        USABLE_WIDTH * 0.18,
        USABLE_WIDTH * 0.15,
        USABLE_WIDTH * 0.12,
      ];
      b.addTable(
        ["Timestamp", "Side", "Quantity", "Price", "Fee", "Source"],
        execRows,
        colExecW,
        ["left", "center", "right", "right", "right", "left"],
        "Executions",
      );
    }

    // Trade Notes
    if (trade.notes?.trim()) {
      b.addSectionHeading("Trade Notes");
      b.addMarkdown(trade.notes);
    }

    // AI Reviews & Critiques (Flows to continuation pages without truncating)
    if (trade.aiReviews && trade.aiReviews.length > 0) {
      b.addSectionHeading(`AI Reviews & Critiques (${trade.aiReviews.length})`);
      for (const rev of trade.aiReviews) {
        b.ensureSpace(35, "AI Review");
        b.currentPage.items.push({
          type: "text",
          x: MARGIN_LEFT,
          y: b.cursorY,
          text: `AI Review · ${rev.provider} (${rev.model})   •   Saved: ${formatDate(rev.createdAt)}`,
          size: 9,
          bold: true,
          color: COLORS.navyAccent,
        });
        b.cursorY += 13;
        b.addMarkdown(rev.content);
        b.cursorY += 6;
      }
    }

    // Document Attachments (PDFs)
    const tradeDocAttachments = trade.attachments.filter((a) => !a.mime.startsWith("image/"));
    if (tradeDocAttachments.length > 0) {
      b.addSectionHeading(`Trade Document Attachments (${tradeDocAttachments.length})`);
      const docRows = tradeDocAttachments.map((a) => [
        a.name,
        a.mime,
        formatFileSize(a.size),
        formatDate(a.createdAt),
      ]);
      const colDocW = [
        USABLE_WIDTH * 0.45,
        USABLE_WIDTH * 0.2,
        USABLE_WIDTH * 0.15,
        USABLE_WIDTH * 0.2,
      ];
      b.addTable(["Document Name", "MIME Type", "Size", "Date Added"], docRows, colDocW, [
        "left",
        "left",
        "right",
        "right",
      ]);
    }

    // Dedicated Trade Screenshot Pages
    const tradeImageAttachments = trade.attachments.filter((a) => a.mime.startsWith("image/"));
    for (const imgAtt of tradeImageAttachments) {
      const norm = normalizedImages.get(imgAtt.id);
      if (norm) {
        b.startNewPage(
          "screenshot",
          `Screenshot: ${imgAtt.name} (Trade ${trade.symbol})`,
          trade.key,
          `trade-${trade.key}-screenshot-${imgAtt.id}`,
        );
        b.addSectionHeading(`Screenshot · Trade ${trade.symbol} (${trade.status.toUpperCase()})`);
        b.currentPage.items.push({
          type: "text",
          x: MARGIN_LEFT,
          y: b.cursorY,
          text: `File: ${imgAtt.name}   •   Size: ${formatFileSize(imgAtt.size)}   •   Format: ${imgAtt.mime}   •   Uploaded: ${formatDate(imgAtt.createdAt)}`,
          size: 8,
          color: COLORS.textMuted,
        });
        b.cursorY += 14;

        // Image fit
        const maxImgW = USABLE_WIDTH;
        const maxImgH = PAGE_HEIGHT - b.cursorY - MARGIN_BOTTOM - 25;
        const scale = Math.min(maxImgW / norm.width, maxImgH / norm.height, 1);
        const imgW = norm.width * scale;
        const imgH = norm.height * scale;
        const imgX = MARGIN_LEFT + (USABLE_WIDTH - imgW) / 2;
        const imgY = b.cursorY + (maxImgH - imgH) / 2;

        b.currentPage.items.push({
          type: "image",
          x: imgX,
          y: imgY,
          w: imgW,
          h: imgH,
          bytes: norm.bytes,
          mime: norm.mime,
          name: imgAtt.name,
        });
        b.cursorY = imgY + imgH + 8;

        const captionText = `Figure: ${imgAtt.name} (${norm.width} × ${norm.height} px, aspect-fit upright)`;
        const wrappedCaption = wrapText(captionText, USABLE_WIDTH, 7.5, b.measure);
        for (const line of wrappedCaption) {
          b.currentPage.items.push({
            type: "text",
            x: PAGE_WIDTH / 2,
            y: b.cursorY,
            text: line,
            size: 7.5,
            color: COLORS.textMuted,
            align: "center",
            maxWidth: USABLE_WIDTH,
          });
          b.cursorY += 10;
        }
      }
    }
  }

  // Stamp header & footer across all pages
  b.finalizeFooters(report.date);

  return b.pages;
}
