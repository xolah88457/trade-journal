import type {
  DailyReport,
  DailyReportTrade,
  ReportAttachment,
  TradeReport,
} from "./daily-report-types";

export const PAGE_WIDTH = 595.28; // Logical A4 points (72 pt / inch)
export const PAGE_HEIGHT = 841.89;
export const MARGIN_LEFT = 40;
export const USABLE_WIDTH = PAGE_WIDTH - MARGIN_LEFT * 2; // 515.28 pt
const MARGIN_TOP = 52;
const MARGIN_BOTTOM = 58;

// Restrained print palette: navy for small accents, green/red only for P&L, greys for structure.
export const COLORS = {
  navyBrand: "#1b365d",
  pageBg: "#ffffff",
  cardBg: "#ffffff",
  cardBorder: "#dfe2e7",
  divider: "#eceef1",
  textMain: "#1a1d21",
  textMuted: "#6b7280",
  profitGreen: "#0b7a3b",
  profitBg: "#e8f5ec",
  profitBorder: "#b7dfc4",
  lossRed: "#c33535",
  lossBg: "#fdeeee",
  lossBorder: "#f1c3c3",
  neutralBg: "#f3f4f6",
  neutralBorder: "#dfe2e7",
  infoBg: "#f3f6fb",
  infoBorder: "#d5deec",
  baseline: "#9aa1ac",
};

/** Type scale: title / big value / tile value / body / caption. */
const SIZE = { title: 22, big: 17, value: 10, body: 9, caption: 7.5 } as const;

type Align = "left" | "center" | "right";

interface RectItem {
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

interface LineItem {
  type: "line";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stroke: string;
  lineWidth?: number;
  dash?: number[];
}

interface TextItem {
  type: "text";
  x: number;
  y: number;
  text: string;
  size: number;
  bold?: boolean;
  color: string;
  align?: Align;
  maxWidth?: number;
}

/** Polyline / polygon (y grows downwards, like every other item). */
interface PathItem {
  type: "path";
  points: [number, number][];
  closed?: boolean;
  fill?: string;
  stroke?: string;
  lineWidth?: number;
}

interface ImageItem {
  type: "image";
  x: number;
  y: number;
  w: number;
  h: number;
  bytes: Uint8Array;
  mime: string;
  name: string;
}

export type LayoutItem = RectItem | LineItem | TextItem | PathItem | ImageItem;

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

const isMixedCurrency = (cur: string) => !cur || cur === "MIXED" || cur.includes(",");

function formatMoney(
  amount: number | null | undefined,
  currency = "USD",
  options: { signed?: boolean; bare?: boolean } = {},
): string {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return "–";

  const cur = (currency || "").trim().toUpperCase();
  const sign = amount > 0 ? (options.signed ? "+" : "") : amount < 0 ? "-" : "";

  // Mixed currencies are never converted: plain number, tagged unless `bare` (chart axes).
  if (isMixedCurrency(cur)) {
    const abs = Math.abs(amount).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return `${sign}${abs}${options.bare ? "" : " (Mixed)"}`;
  }

  const absAmount = Math.abs(amount);
  const isTiny = absAmount !== 0 && absAmount < 0.01;
  const fractionDigits = isTiny
    ? Math.min(8, Math.max(2, -Math.floor(Math.log10(absAmount)) + 2))
    : 2;

  try {
    const formatter = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: cur,
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    });
    return `${sign}${formatter.format(absAmount)}`;
  } catch {
    // Non-ISO currency codes (e.g. USDT, USDC, BTC, ETH)
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

const formatPercent = (val: number) => `${(val * 100).toFixed(1)}%`;

const formatR = (val: number, signed = false) => `${formatNumber(val, 2, { signed })}R`;

function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms) || ms < 0) return "–";
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "2026-09-17" -> "Thursday, 17 September 2026" (no locale dependence). */
function formatLongDate(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const weekday = WEEKDAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
  return `${weekday}, ${d} ${MONTHS[mo - 1]} ${y}`;
}

// ---------------------------------------------------------------------------
// Time zone helpers
// ---------------------------------------------------------------------------

interface Zoned {
  date: string; // YYYY-MM-DD
  hm: string; // HH:MM
  hms: string; // HH:MM:SS
}

const zoneFormats = new Map<string, Intl.DateTimeFormat>();

function zoneFormat(timeZone: string): Intl.DateTimeFormat {
  let f = zoneFormats.get(timeZone);
  if (!f) {
    const options: Intl.DateTimeFormatOptions = {
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    };
    try {
      f = new Intl.DateTimeFormat("en-GB", { ...options, timeZone });
    } catch {
      f = new Intl.DateTimeFormat("en-GB", { ...options, timeZone: "UTC" });
    }
    zoneFormats.set(timeZone, f);
  }
  return f;
}

function zoned(iso: string | null | undefined, timeZone: string): Zoned | null {
  const ms = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(ms)) return null;
  const p: Record<string, string> = {};
  for (const part of zoneFormat(timeZone).formatToParts(ms)) p[part.type] = part.value;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hm: `${p.hour}:${p.minute}`,
    hms: `${p.hour}:${p.minute}:${p.second}`,
  };
}

/** "2026-09-17 13:48" in the report time zone; falls back to the raw string. */
function formatStamp(iso: string | null | undefined, timeZone: string): string {
  const z = zoned(iso, timeZone);
  return z ? `${z.date} ${z.hm}` : (iso ?? "");
}

// ---------------------------------------------------------------------------
// Trade value helpers
// ---------------------------------------------------------------------------

const decimalsOf = (n: number) => {
  const s = String(Math.abs(n));
  return s.includes("e") || s.includes("E") ? null : (s.split(".")[1]?.length ?? 0);
};

/**
 * One price formatter per trade so entry, exit and fills share a precision (the most decimals
 * seen in its fills, capped). Exponent-form values keep their exact round-trip representation.
 */
function priceFormatter(trade: DailyReportTrade): (n: number | null | undefined) => string {
  const all = [
    trade.avgEntry,
    trade.avgExit,
    trade.stopLoss,
    trade.profitTarget,
    ...trade.executions.map((e) => e.price),
  ].filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  const seen = all.map(decimalsOf);
  if (seen.includes(null)) return (n) => formatPrecision(n);
  const fills = trade.executions.map((e) => decimalsOf(e.price) ?? 0);
  const decimals = Math.min(
    6,
    fills.length ? Math.max(...fills) : Math.min(4, Math.max(0, ...(seen as number[]))),
  );
  return (n) => (n == null ? "–" : formatNumber(n, decimals));
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

/** Caches a pure measure function by (size, text); wrapping re-measures the same strings repeatedly. */
function memoizeMeasure(measure: MeasureFn): MeasureFn {
  const bySize = new Map<number, Map<string, number>>();
  return (text, size) => {
    let cache = bySize.get(size);
    if (!cache) bySize.set(size, (cache = new Map()));
    let width = cache.get(text);
    if (width === undefined) cache.set(text, (width = measure(text, size)));
    return width;
  };
}

function wrapText(
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

interface MarkdownBlock {
  type: "heading" | "paragraph" | "list" | "quote" | "divider" | "code" | "table";
  level?: number;
  text?: string;
  items?: { text: string; checked?: boolean; orderedNum?: number }[];
  headers?: string[];
  rows?: string[][];
}

function parseMarkdown(src: string): MarkdownBlock[] {
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

interface InlineRun {
  text: string;
  bold: boolean;
}

/** Drops italic and code markers and backslash escapes; there is no italic or mono face. */
const stripInline = (text: string) =>
  text
    .replace(/(?<![*\w\\])\*(?=\S)(.+?)(?<=[^\s\\])\*(?![*\w])/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\\([\\`*_{}[\]()<>#!|~+.-])/g, "$1");

/** Inline markdown -> runs: `**bold**` keeps its weight, links show their label only. */
function inlineRuns(src: string): InlineRun[] {
  const text = src.replace(/\[((?:\\.|[^\]\\])*)\]\([^()\s]+\)/g, "$1");
  const runs: InlineRun[] = [];
  const add = (part: string, bold: boolean) => {
    const clean = stripInline(part);
    if (clean) runs.push({ text: clean, bold });
  };
  let last = 0;
  for (const m of text.matchAll(/(?<!\\)\*\*(?=\S)(.+?)(?<=[^\s\\])\*\*/g)) {
    add(text.slice(last, m.index), false);
    add(m[1]!, true);
    last = m.index + m[0].length;
  }
  add(text.slice(last), false);
  return runs;
}

const plainInline = (src: string) =>
  inlineRuns(src)
    .map((r) => r.text)
    .join("");

// ---------------------------------------------------------------------------
// Page Layout Builder
// ---------------------------------------------------------------------------

type Cell = string | { text: string; color?: string; bold?: boolean };
interface Col {
  header: string;
  w: number; // relative weight
  align?: Align;
}
interface Tone {
  color: string;
  bg: string;
  border: string;
}
interface Tile {
  label: string;
  value: string;
  color?: string;
}

const TONES = {
  win: { color: COLORS.profitGreen, bg: COLORS.profitBg, border: COLORS.profitBorder },
  loss: { color: COLORS.lossRed, bg: COLORS.lossBg, border: COLORS.lossBorder },
  flat: { color: COLORS.textMuted, bg: COLORS.neutralBg, border: COLORS.neutralBorder },
  info: { color: COLORS.navyBrand, bg: COLORS.infoBg, border: COLORS.infoBorder },
} satisfies Record<string, Tone>;

const CHART_TINT = { win: "#e4f2ea", loss: "#fbeaea" };

const pnlColor = (n: number | null | undefined) =>
  !n ? COLORS.textMain : n > 0 ? COLORS.profitGreen : COLORS.lossRed;

const statusTone = (status: DailyReportTrade["status"]): Tone =>
  status === "win" ? TONES.win : status === "loss" ? TONES.loss : TONES.flat;

const statusLabel = (status: DailyReportTrade["status"]) =>
  status === "breakeven" ? "BE" : status.toUpperCase();

class PageLayoutBuilder {
  pages: ReportPageLayout[] = [];
  page!: ReportPageLayout;
  y = MARGIN_TOP;
  readonly maxY = PAGE_HEIGHT - MARGIN_BOTTOM;
  /** Horizontal extent of the current text column (narrowed inside tinted blocks). */
  x0 = MARGIN_LEFT;
  w = USABLE_WIDTH;

  private kind: ReportPageLayout["kind"] = "daily";
  private tradeKey?: string;
  private baseTitle = "";
  private backdrop: { fill: string; at: number; y0: number } | null = null;

  constructor(
    readonly measure: MeasureFn,
    readonly timeZone: string,
  ) {}

  push(item: LayoutItem): void {
    this.page.items.push(item);
  }

  width(text: string, size: number, bold = false): number {
    return this.measure(text, size) * (bold ? 1.04 : 1);
  }

  startPage(kind: ReportPageLayout["kind"], title: string, tradeKey?: string, id?: string): void {
    this.closeBackdrop();
    this.kind = kind;
    this.tradeKey = tradeKey;
    const cleanBase = title.replace(/\s*\(Continued\).*$/, "").trim();
    if (cleanBase) this.baseTitle = cleanBase;

    const pageIndex = this.pages.length;
    this.page = {
      id: id ?? (tradeKey ? `trade-${tradeKey}-p${pageIndex + 1}` : `daily-p${pageIndex + 1}`),
      title,
      kind,
      tradeKey,
      pageIndex,
      items: [{ type: "rect", x: 0, y: 0, w: PAGE_WIDTH, h: 3, fill: COLORS.navyBrand }],
    };
    this.pages.push(this.page);
    this.y = MARGIN_TOP;
  }

  /** Starts a continuation page; a tinted block in progress keeps going on the new page. */
  breakPage(context = ""): void {
    const backdrop = this.backdrop;
    this.startPage(
      this.kind,
      `${this.baseTitle} (Continued)${context ? ` · ${context}` : ""}`,
      this.tradeKey,
    );
    this.text(MARGIN_LEFT, this.y, `${this.baseTitle} (continued)`, SIZE.caption, COLORS.textMuted);
    this.y += 20;
    if (backdrop) this.beginBackdrop(backdrop.fill);
  }

  ensureSpace(height: number, context = ""): void {
    if (this.y + height > this.maxY) this.breakPage(context);
  }

  /** Tinted block behind whatever is laid out until `closeBackdrop` (may span pages). */
  beginBackdrop(fill: string): void {
    this.backdrop = { fill, at: this.page.items.length, y0: this.y };
  }

  closeBackdrop(): void {
    const b = this.backdrop;
    this.backdrop = null;
    if (!b || this.y <= b.y0) return;
    this.page.items.splice(b.at, 0, {
      type: "rect",
      x: MARGIN_LEFT,
      y: b.y0,
      w: USABLE_WIDTH,
      h: Math.min(this.y, this.maxY) - b.y0,
      fill: b.fill,
      radius: 4,
    });
  }

  text(
    x: number,
    y: number,
    text: string,
    size: number,
    color: string,
    o: { bold?: boolean; align?: Align; maxWidth?: number } = {},
  ): void {
    this.push({
      type: "text",
      x,
      y,
      text,
      size,
      color,
      bold: o.bold,
      align: o.align,
      maxWidth: o.maxWidth ?? USABLE_WIDTH,
    });
  }

  /** Word-wraps mixed-weight runs; each line is a list of segments with their x offset. */
  wrapRuns(runs: InlineRun[], maxWidth: number, size: number) {
    type Seg = { text: string; bold: boolean; dx: number };
    const words: { text: string; bold: boolean; gap: boolean }[] = [];
    let gap = false;
    for (const run of runs)
      for (const part of run.text.split(/(\s+)/)) {
        if (!part) continue;
        if (!part.trim()) gap = true;
        else {
          words.push({ text: part, bold: run.bold, gap: gap && words.length > 0 });
          gap = false;
        }
      }

    // Synthetic bold (PDF stroke, canvas fake bold) keeps regular advances, so runs use the
    // plain measure for placement; `width()`'s bold allowance would leave gaps after bold runs.
    const advance = (text: string) => this.measure(text, size);
    const lineWidth = (segs: Seg[]) => segs.reduce((sum, s) => sum + advance(s.text), 0);
    const append = (segs: Seg[], text: string, bold: boolean, withGap: boolean): Seg[] => {
      const next = segs.map((s) => ({ ...s }));
      const last = next[next.length - 1];
      if (last && withGap) last.text += " ";
      if (last && last.bold === bold) last.text += text;
      else next.push({ text, bold, dx: 0 });
      return next;
    };

    const lines: Seg[][] = [];
    let line: Seg[] = [];
    for (const word of words) {
      const candidate = append(line, word.text, word.bold, word.gap);
      if (!line.length || lineWidth(candidate) <= maxWidth) {
        line = candidate;
        if (lineWidth(line) <= maxWidth) continue;
      } else {
        lines.push(line);
        line = [{ text: word.text, bold: word.bold, dx: 0 }];
        if (advance(word.text) <= maxWidth) continue;
      }
      // A single unbroken token wider than the column: hard-break it like wrapText does.
      const pieces = wrapText(line[line.length - 1]!.text, maxWidth, size, this.measure);
      const head = line.slice(0, -1);
      if (head.length) lines.push(head);
      for (const piece of pieces.slice(0, -1))
        lines.push([{ text: piece, bold: word.bold, dx: 0 }]);
      line = [{ text: pieces[pieces.length - 1]!, bold: word.bold, dx: 0 }];
    }
    if (line.length) lines.push(line);
    for (const segs of lines) {
      let dx = 0;
      for (const s of segs) {
        s.dx = dx;
        dx += advance(s.text);
      }
    }
    return lines.length ? lines : [[]];
  }

  /** Wrapped inline-markdown text; continuation lines start at `indent` past `x`. */
  addRich(
    runs: InlineRun[],
    o: {
      x: number;
      w: number;
      size?: number;
      lineHeight?: number;
      color?: string;
      indent?: number;
    },
  ): void {
    const size = o.size ?? SIZE.body;
    const lineHeight = o.lineHeight ?? size * 1.4;
    const indent = o.indent ?? 0;
    this.wrapRuns(runs, o.w - indent, size).forEach((segs, i) => {
      this.ensureSpace(lineHeight);
      const x = o.x + (i === 0 ? 0 : indent);
      for (const s of segs)
        this.text(x + s.dx, this.y, s.text, size, o.color ?? COLORS.textMain, {
          bold: s.bold || undefined,
          maxWidth: o.w - indent - s.dx,
        });
      this.y += lineHeight;
    });
  }

  hline(y: number, x1 = this.x0, x2 = this.x0 + this.w, stroke = COLORS.divider, lineWidth = 0.5) {
    this.push({ type: "line", x1, y1: y, x2, y2: y, stroke, lineWidth });
  }

  addText(
    text: string,
    size: number,
    color = COLORS.textMain,
    o: { bold?: boolean; x?: number; w?: number } = {},
  ): void {
    const lineHeight = size * 1.4;
    for (const line of wrapText(text, o.w ?? this.w, size, this.measure)) {
      this.ensureSpace(lineHeight);
      this.text(o.x ?? this.x0, this.y, line, size, color, {
        bold: o.bold,
        maxWidth: o.w ?? this.w,
      });
      this.y += lineHeight;
    }
  }

  /** Small uppercase section label with a hairline underneath. */
  sectionLabel(title: string, caption?: string, minBody = 50): void {
    this.ensureSpace(minBody + 24, title);
    this.y += 16;
    this.text(MARGIN_LEFT, this.y, title.toUpperCase(), 8, COLORS.navyBrand, { bold: true });
    if (caption) {
      this.text(MARGIN_LEFT + USABLE_WIDTH, this.y, caption, SIZE.caption, COLORS.textMuted, {
        align: "right",
        maxWidth: USABLE_WIDTH - 120,
      });
    }
    this.y += 14;
    this.hline(this.y, MARGIN_LEFT, MARGIN_LEFT + USABLE_WIDTH, COLORS.cardBorder, 0.75);
    this.y += 10;
  }

  /** Rounded pill; returns its width. */
  pill(x: number, y: number, text: string, tone: Tone): number {
    const w = this.width(text, 7, true) + 12;
    this.push({
      type: "rect",
      x,
      y,
      w,
      h: 13,
      fill: tone.bg,
      stroke: tone.border,
      lineWidth: 0.5,
      radius: 6.5,
    });
    this.text(x + 6, y + 2.5, text, 7, tone.color, { bold: true, maxWidth: w });
    return w;
  }

  /** Label + wrapped row of pills (tags, mistakes). */
  pillRow(label: string, items: string[], tone: Tone): void {
    const startX = MARGIN_LEFT + 54;
    let x = startX;
    this.ensureSpace(20);
    this.text(MARGIN_LEFT, this.y + 3, label, SIZE.caption, COLORS.textMuted);
    for (const item of items) {
      const pw = this.width(item, 7, true) + 12;
      if (x + pw > MARGIN_LEFT + USABLE_WIDTH && x > startX) {
        x = startX;
        this.y += 18;
        this.ensureSpace(18);
      }
      x += this.pill(x, this.y, item, tone) + 5;
    }
    this.y += 22;
  }

  /** Grid of small tiles: caption label above, value below. */
  tiles(items: Tile[], cols = 6): void {
    const gap = 8;
    const tw = (USABLE_WIDTH - gap * (cols - 1)) / cols;
    const th = 40;
    for (let i = 0; i < items.length; i += cols) {
      this.ensureSpace(th + gap);
      items.slice(i, i + cols).forEach((tile, j) => {
        const x = MARGIN_LEFT + j * (tw + gap);
        this.push({ type: "rect", x, y: this.y, w: tw, h: th, fill: COLORS.neutralBg, radius: 4 });
        this.text(x + 9, this.y + 8, tile.label, SIZE.caption, COLORS.textMuted, {
          maxWidth: tw - 14,
        });
        this.text(x + 9, this.y + 21, tile.value, SIZE.value, tile.color ?? COLORS.textMain, {
          bold: true,
          maxWidth: tw - 14,
        });
      });
      this.y += th + gap;
    }
  }

  /** Label (muted, left) / value (right-aligned) list flowing down `cols` columns. */
  kv(rows: { label: string; value: string; color?: string }[], cols = 2): void {
    if (!rows.length) return;
    const gap = 28;
    const cw = (USABLE_WIDTH - gap) / cols;
    const rowH = 19;
    const per = Math.ceil(rows.length / cols);
    this.ensureSpace(per * rowH);
    rows.forEach((row, i) => {
      const x = MARGIN_LEFT + Math.floor(i / per) * (cw + gap);
      const y = this.y + (i % per) * rowH;
      this.text(x, y + 5, row.label, SIZE.body, COLORS.textMuted, { maxWidth: cw * 0.6 });
      this.text(x + cw, y + 5, row.value, SIZE.body, row.color ?? COLORS.textMain, {
        bold: true,
        align: "right",
        maxWidth: cw * 0.6,
      });
      this.hline(y + rowH, x, x + cw);
    });
    this.y += per * rowH + 8;
  }

  /** Clean table: muted header, hairline rows, repeated header on continuation pages. */
  table(cols: Col[], rows: Cell[][], name = "Table"): void {
    if (!rows.length) return;
    const total = cols.reduce((sum, c) => sum + c.w, 0);
    const widths = cols.map((c) => (c.w / total) * USABLE_WIDTH);
    const lastCol = cols.length - 1;
    const padL = (i: number) => (i === 0 ? 0 : 6);
    const padR = (i: number) => (i === lastCol ? 0 : 6);
    const colX = (i: number) => MARGIN_LEFT + widths.slice(0, i).reduce((s, v) => s + v, 0);
    const textX = (i: number) => {
      const align = cols[i]!.align ?? "left";
      return align === "right"
        ? colX(i) + widths[i]! - padR(i)
        : align === "center"
          ? colX(i) + widths[i]! / 2
          : colX(i) + padL(i);
    };
    const lineH = 11.5;
    const padY = 4.5;

    const header = () => {
      cols.forEach((c, i) =>
        this.text(textX(i), this.y, c.header, SIZE.caption, COLORS.textMuted, {
          bold: true,
          align: c.align,
          maxWidth: widths[i]! - padL(i) - padR(i),
        }),
      );
      this.y += 13;
      this.hline(this.y, MARGIN_LEFT, MARGIN_LEFT + USABLE_WIDTH, COLORS.cardBorder, 0.75);
    };

    this.ensureSpace(13 + lineH * 2 + padY * 2, name);
    header();

    for (const row of rows) {
      const cells = row.map((c) => (typeof c === "string" ? { text: c } : c));
      const wrapped = cells.map((c, i) =>
        wrapText(c.text, widths[i]! - padL(i) - padR(i), SIZE.body, this.measure),
      );
      const totalLines = Math.max(1, ...wrapped.map((l) => l.length));
      let offset = 0;
      while (offset < totalLines) {
        if (this.maxY - this.y < lineH + padY * 2 + 4) {
          this.breakPage(name);
          header();
        }
        const fit = Math.max(1, Math.floor((this.maxY - this.y - padY * 2) / lineH));
        const lines = Math.min(totalLines - offset, fit);
        const h = lines * lineH + padY * 2;
        cells.forEach((cell, i) => {
          for (let l = 0; l < lines; l++) {
            const line = wrapped[i]![offset + l];
            if (line === undefined) continue;
            this.text(
              textX(i),
              this.y + padY + l * lineH,
              line,
              SIZE.body,
              cell.color ?? COLORS.textMain,
              {
                bold: cell.bold,
                align: cols[i]!.align,
                maxWidth: widths[i]! - padL(i) - padR(i),
              },
            );
          }
        });
        this.hline(this.y + h, MARGIN_LEFT, MARGIN_LEFT + USABLE_WIDTH);
        this.y += h;
        offset += lines;
      }
    }
    this.y += 8;
  }

  /**
   * Equity-style curve drawn entirely from generic primitives (area, dashed zero line, time ticks,
   * money axis labels, end label to the right of the end dot) so both renderers match.
   */
  chart(o: {
    title: string;
    caption?: string;
    points: { t: string; cumNetPnl: number }[];
    currency: string;
    h: number;
  }): void {
    const { points, currency: cur, h } = o;
    this.ensureSpace(h + 40, o.title);
    this.sectionLabel(o.title, o.caption, h);
    const y0 = this.y;
    this.y += h + 6;
    if (!points.length) {
      this.text(MARGIN_LEFT, y0 + 8, "No curve points recorded.", SIZE.body, COLORS.textMuted);
      return;
    }

    const vals = points.map((p) => p.cumNetPnl);
    const times = points.map((p) => Date.parse(p.t));
    const timed = times.every(Number.isFinite) && times[times.length - 1]! > times[0]!;
    const lo = Math.min(0, ...vals);
    const hi = Math.max(0, ...vals);
    const pad = (hi - lo || 1) * 0.08;
    const yMin = lo - pad;
    const yMax = hi + pad;
    const fmt = (v: number) => formatMoney(v, cur, { signed: true, bare: true });

    const last = vals[vals.length - 1]!;
    const color = last >= 0 ? COLORS.profitGreen : COLORS.lossRed;
    const endLabel = fmt(last);
    const axisValues = [...new Set([hi, lo, 0])];
    const gutter = Math.max(...axisValues.map((v) => this.width(fmt(v), 7))) + 10;
    const left = MARGIN_LEFT + gutter;
    const right = MARGIN_LEFT + USABLE_WIDTH - (this.width(endLabel, 7.5, true) + 14);
    const top = y0 + 4;
    const bottom = y0 + h - 18;
    const sy = (v: number) => bottom - ((v - yMin) / (yMax - yMin)) * (bottom - top);
    const sx = (i: number) =>
      timed
        ? left + ((times[i]! - times[0]!) / (times[times.length - 1]! - times[0]!)) * (right - left)
        : left + (i / Math.max(1, points.length - 1)) * (right - left);

    // Gridlines (max / min), dashed zero baseline, bottom axis
    for (const v of [hi, lo]) if (v !== 0) this.hline(sy(v), left, right);
    this.push({
      type: "line",
      x1: left,
      y1: sy(0),
      x2: right,
      y2: sy(0),
      stroke: COLORS.baseline,
      lineWidth: 0.75,
      dash: [3, 2],
    });
    this.hline(bottom, left, right, COLORS.cardBorder, 0.75);

    // Y labels (skip ones that would collide with another)
    const labelled: number[] = [];
    for (const v of [hi, lo, 0]) {
      if (labelled.some((o2) => Math.abs(sy(o2) - sy(v)) < 9)) continue;
      labelled.push(v);
      this.text(left - 6, sy(v) - 4, fmt(v), 7, COLORS.textMuted, {
        align: "right",
        maxWidth: gutter,
      });
    }

    // X labels: HH:MM in the report time zone at evenly spaced instants
    const ticks: { x: number; text: string; align: Align }[] = [];
    if (timed) {
      const n = right - left > 180 ? 4 : 3;
      const first = zoned(new Date(times[0]!).toISOString(), this.timeZone);
      const lastZ = zoned(new Date(times[times.length - 1]!).toISOString(), this.timeZone);
      const multiDay = first && lastZ && first.date !== lastZ.date;
      for (let k = 0; k < n; k++) {
        const frac = k / (n - 1);
        const z = zoned(
          new Date(times[0]! + frac * (times[times.length - 1]! - times[0]!)).toISOString(),
          this.timeZone,
        );
        if (!z) continue;
        const text = multiDay ? `${z.date.slice(5)} ${z.hm}` : z.hm;
        if (ticks.length && ticks[ticks.length - 1]!.text === text) continue;
        ticks.push({
          x: left + frac * (right - left),
          text,
          align: k === 0 ? "left" : k === n - 1 ? "right" : "center",
        });
      }
    } else if (points.length > 1) {
      ticks.push({ x: left, text: points[0]!.t, align: "left" });
      ticks.push({ x: right, text: points[points.length - 1]!.t, align: "right" });
    }
    for (const t of ticks) {
      this.push({
        type: "line",
        x1: t.x,
        y1: bottom,
        x2: t.x,
        y2: bottom + 2.5,
        stroke: COLORS.baseline,
        lineWidth: 0.5,
      });
      this.text(t.x, bottom + 5, t.text, 7, COLORS.textMuted, { align: t.align, maxWidth: 80 });
    }

    // Area, line, markers
    const coords = points.map((p, i): [number, number] => [sx(i), sy(p.cumNetPnl)]);
    this.push({
      type: "path",
      points: [[coords[0]![0], sy(0)], ...coords, [coords[coords.length - 1]![0], sy(0)]],
      closed: true,
      fill: last >= 0 ? CHART_TINT.win : CHART_TINT.loss,
    });
    this.push({ type: "path", points: coords, stroke: color, lineWidth: 1.4 });
    const dot = (cx: number, cy: number, r: number, fill: string) =>
      this.push({
        type: "rect",
        x: cx - r,
        y: cy - r,
        w: r * 2,
        h: r * 2,
        radius: r,
        fill,
        stroke: color,
        lineWidth: 1,
      });
    if (points.length <= 40) coords.slice(0, -1).forEach(([cx, cy]) => dot(cx, cy, 1.6, "#ffffff"));
    const [lx, ly] = coords[coords.length - 1]!;
    dot(lx, ly, 3, color);
    this.text(lx + 8, Math.min(Math.max(ly - 4.5, top), bottom - 9), endLabel, 7.5, color, {
      bold: true,
      maxWidth: 90,
    });
  }

  addMarkdown(markdownText: string): void {
    if (!markdownText?.trim()) return;
    const x0 = this.x0;
    const w = this.w;

    for (const block of parseMarkdown(markdownText)) {
      if (block.type === "divider") {
        this.ensureSpace(14);
        this.hline(this.y + 6);
        this.y += 14;
      } else if (block.type === "heading") {
        const size = block.level === 1 ? 12 : block.level === 2 ? 10.5 : SIZE.body;
        // Keep a heading with at least two lines of what follows
        this.ensureSpace(size * 1.4 + 30, plainInline(block.text ?? ""));
        this.y += 4;
        this.addText(
          plainInline(block.text ?? ""),
          size,
          block.level! <= 2 ? COLORS.navyBrand : COLORS.textMain,
          {
            bold: true,
          },
        );
        this.y += 2;
      } else if (block.type === "paragraph") {
        this.addRich(inlineRuns(block.text ?? ""), { x: x0, w });
        this.y += 4;
      } else if (block.type === "list") {
        for (const item of block.items ?? []) {
          const prefix =
            item.checked !== undefined
              ? item.checked
                ? "[x] "
                : "[ ] "
              : item.orderedNum
                ? `${item.orderedNum}. `
                : "• ";
          this.addRich([{ text: prefix, bold: false }, ...inlineRuns(item.text)], {
            x: x0 + 4,
            w: w - 4,
            indent: 12,
            lineHeight: 13,
            color: item.checked ? COLORS.profitGreen : COLORS.textMain,
          });
        }
        this.y += 4;
      } else if (block.type === "quote") {
        let start = this.y;
        const bar = () =>
          this.y > start &&
          this.push({
            type: "line",
            x1: x0 + 3,
            y1: start,
            x2: x0 + 3,
            y2: this.y,
            stroke: COLORS.baseline,
            lineWidth: 2,
          });
        for (const line of wrapText(
          plainInline(block.text ?? ""),
          w - 20,
          SIZE.body,
          this.measure,
        )) {
          if (this.y + 13 > this.maxY) {
            bar();
            this.ensureSpace(20, "Quote");
            start = this.y;
          }
          this.text(x0 + 14, this.y, line, SIZE.body, COLORS.textMuted, { maxWidth: w - 20 });
          this.y += 13;
        }
        bar();
        this.y += 6;
      } else if (block.type === "code") {
        const lines = (block.text ?? "")
          .split(/\r?\n/)
          .flatMap((line) => wrapText(line || " ", w - 16, 8, this.measure));
        for (let i = 0; i < lines.length;) {
          if (this.maxY - this.y < 40) this.breakPage("Code");
          const fit = Math.max(1, Math.floor((this.maxY - this.y - 8) / 11));
          const chunk = lines.slice(i, i + fit);
          const h = chunk.length * 11 + 8;
          this.push({
            type: "rect",
            x: x0,
            y: this.y,
            w,
            h,
            fill: COLORS.neutralBg,
            radius: 3,
          });
          chunk.forEach((line, k) =>
            this.text(x0 + 8, this.y + 4 + k * 11, line, 8, COLORS.textMain, { maxWidth: w - 16 }),
          );
          this.y += h + 4;
          i += chunk.length;
        }
        this.y += 4;
      } else if (block.type === "table" && block.headers && block.rows) {
        this.table(
          block.headers.map((header) => ({ header: plainInline(header), w: 1 })),
          block.rows.map((row) => row.map(plainInline)),
          "Note Table",
        );
      }
    }
  }

  finalizeFooters(left: string, exported: string): void {
    const total = this.pages.length;
    const y = PAGE_HEIGHT - 34;
    this.pages.forEach((page, idx) => {
      this.page = page;
      this.hline(y - 8, MARGIN_LEFT, MARGIN_LEFT + USABLE_WIDTH);
      this.text(MARGIN_LEFT, y, left, SIZE.caption, COLORS.textMuted);
      this.text(PAGE_WIDTH / 2, y, exported, SIZE.caption, COLORS.textMuted, {
        align: "center",
        maxWidth: 260,
      });
      this.text(
        MARGIN_LEFT + USABLE_WIDTH,
        y,
        `Page ${idx + 1} of ${total}`,
        SIZE.caption,
        COLORS.textMuted,
        {
          align: "right",
        },
      );
    });
  }
}

/** Lists non-image attachments (metadata only) as a table under a section heading. */
function addDocumentTable(b: PageLayoutBuilder, heading: string, docs: ReportAttachment[]) {
  b.sectionLabel(heading);
  b.table(
    [
      { header: "Document", w: 0.42 },
      { header: "Type", w: 0.22 },
      { header: "Size", w: 0.14, align: "right" },
      { header: "Added", w: 0.22, align: "right" },
    ],
    docs.map((a) => [a.name, a.mime, formatFileSize(a.size), formatStamp(a.createdAt, b.timeZone)]),
    "Documents",
  );
}

/** Body of a dedicated screenshot page: metadata line, aspect-fit image and wrapped caption. */
function addScreenshotBody(
  b: PageLayoutBuilder,
  name: string,
  norm: NormalizedImage,
  metaText: string,
) {
  b.addText(metaText, SIZE.caption, COLORS.textMuted);
  b.y += 8;

  const maxH = b.maxY - b.y - 34;
  const scale = Math.min(USABLE_WIDTH / norm.width, maxH / norm.height, 1);
  const imgW = norm.width * scale;
  const imgH = norm.height * scale;
  const imgX = MARGIN_LEFT + (USABLE_WIDTH - imgW) / 2;
  b.push({
    type: "image",
    x: imgX,
    y: b.y,
    w: imgW,
    h: imgH,
    bytes: norm.bytes,
    mime: norm.mime,
    name,
  });
  b.push({
    type: "rect",
    x: imgX,
    y: b.y,
    w: imgW,
    h: imgH,
    stroke: COLORS.cardBorder,
    lineWidth: 0.5,
  });
  b.y += imgH + 10;

  for (const line of wrapText(
    `Figure: ${name} (${norm.width} × ${norm.height} px)`,
    USABLE_WIDTH,
    SIZE.caption,
    b.measure,
  )) {
    b.text(PAGE_WIDTH / 2, b.y, line, SIZE.caption, COLORS.textMuted, { align: "center" });
    b.y += 10;
  }
}

// ---------------------------------------------------------------------------
// Overview + trade page sections
// ---------------------------------------------------------------------------

function addKpiRow(
  b: PageLayoutBuilder,
  cards: { label: string; value: string; color?: string; sub: string[] }[],
) {
  const gap = 8;
  const cw = (USABLE_WIDTH - gap * 3) / 4;
  const subLines = cards.map((c) =>
    c.sub.flatMap((line) => wrapText(line, cw - 20, SIZE.caption, b.measure)),
  );
  const ch = 50 + 10 * Math.max(...subLines.map((s) => s.length));
  b.ensureSpace(ch + 8);
  cards.forEach((card, i) => {
    const x = MARGIN_LEFT + i * (cw + gap);
    b.push({
      type: "rect",
      x,
      y: b.y,
      w: cw,
      h: ch,
      fill: COLORS.cardBg,
      stroke: COLORS.cardBorder,
      lineWidth: 0.75,
      radius: 5,
    });
    b.text(x + 10, b.y + 10, card.label, SIZE.caption, COLORS.textMuted, { maxWidth: cw - 20 });
    b.text(x + 10, b.y + 22, card.value, SIZE.big, card.color ?? COLORS.textMain, {
      bold: true,
      maxWidth: cw - 20,
    });
    subLines[i]!.forEach((line, k) =>
      b.text(x + 10, b.y + 46 + k * 10, line, SIZE.caption, COLORS.textMuted, {
        maxWidth: cw - 20,
      }),
    );
  });
  b.y += ch + 8;
}

/** "A · B" on one line when it fits the card, otherwise two lines. */
const joinSub = (b: PageLayoutBuilder, a: string, c: string) =>
  b.width(`${a} · ${c}`, SIZE.caption) < (USABLE_WIDTH - 24) / 4 - 20 ? [`${a} · ${c}`] : [a, c];

function addOverview(b: PageLayoutBuilder, report: DailyReport) {
  const tz = report.timeZone;
  const m = report.metrics;
  const mixed = report.scope.currencies.length > 1;
  const cur = mixed ? "MIXED" : (report.scope.currencies[0] ?? "USD");
  const money = (n: number | null | undefined, signed = false) => formatMoney(n, cur, { signed });

  b.startPage("daily", `Daily overview · ${report.date}`, undefined, "daily-overview");

  // Header: eyebrow, readable date, one muted scope line
  b.text(MARGIN_LEFT, b.y, "DAILY REPORT", 8, COLORS.navyBrand, { bold: true });
  b.y += 15;
  b.text(MARGIN_LEFT, b.y, formatLongDate(report.date), SIZE.title, COLORS.textMain, {
    bold: true,
  });
  b.y += 32;
  const scopeLine = [
    report.scope.label || "All trades",
    report.scope.accountNames.length ? report.scope.accountNames.join(", ") : "All accounts",
    mixed ? `${report.scope.currencies.join(", ")} (mixed, not converted)` : cur,
    tz,
  ].join(" · ");
  b.addText(scopeLine, SIZE.body, COLORS.textMuted);
  b.y += 12;

  addKpiRow(b, [
    {
      label: "Net P&L",
      value: money(m.netPnl, true),
      color: pnlColor(m.netPnl),
      sub: joinSub(b, `Gross ${money(m.grossPnl)}`, `Fees ${money(m.fees)}`),
    },
    {
      label: "Trades",
      value: String(m.closedTrades),
      sub: [`${m.wins}W · ${m.losses}L · ${m.breakevens}BE`],
    },
    {
      label: "Win rate",
      value: m.winRate === null ? "–" : formatPercent(m.winRate),
      sub: [
        ...(m.avgWin === null ? [] : [`Avg win ${money(m.avgWin)}`]),
        ...(m.avgLoss === null ? [] : [`Avg loss ${money(m.avgLoss)}`]),
      ],
    },
    {
      label: "Profit factor",
      value: report.profitFactorIsInfinite ? "No losses" : formatNumber(m.profitFactor),
      sub: m.expectancy === null ? [] : [`Expectancy ${money(m.expectancy)}`],
    },
  ]);

  // Intraday equity (anchored at the first trade open so the curve starts from zero)
  const curve = [...report.intraday];
  const firstOpen = report.trades.map((t) => t.openedAt).sort()[0];
  if (curve.length && firstOpen && Date.parse(firstOpen) < Date.parse(curve[0]!.t)) {
    curve.unshift({ t: firstOpen, cumNetPnl: 0 });
  }
  b.chart({
    title: "Intraday equity",
    caption: mixed ? "Mixed currencies, not converted" : undefined,
    points: curve,
    currency: cur,
    h: 130,
  });

  // Trades of the day
  if (report.trades.length) {
    const rows = [...report.trades]
      .sort((x, y) => x.openedAt.localeCompare(y.openedAt) || x.key.localeCompare(y.key))
      .map((t): Cell[] => {
        const price = priceFormatter(t);
        const opened = zoned(t.openedAt, tz);
        const time = !opened
          ? ""
          : opened.date === report.date
            ? opened.hm
            : `${opened.date.slice(5)} ${opened.hm}`;
        const open = t.status === "open";
        return [
          time,
          { text: t.symbol, bold: true },
          t.direction === "long" ? "Long" : "Short",
          formatPrecision(t.quantity),
          price(t.avgEntry),
          open || t.avgExit === null ? "Open" : price(t.avgExit),
          open ? "–" : formatDuration(t.durationMs),
          {
            text: open ? "Open" : formatMoney(t.netPnl, t.currency, { signed: true }),
            color: open ? undefined : pnlColor(t.netPnl),
            bold: true,
          },
        ];
      });
    b.sectionLabel("Trades", `${rows.length} ${rows.length === 1 ? "trade" : "trades"}`, 60);
    b.table(
      [
        { header: "Time", w: 0.1 },
        { header: "Symbol", w: 0.16 },
        { header: "Side", w: 0.09 },
        { header: "Qty", w: 0.11, align: "right" },
        { header: "Entry", w: 0.14, align: "right" },
        { header: "Exit", w: 0.14, align: "right" },
        { header: "Duration", w: 0.12, align: "right" },
        { header: "Net P&L", w: 0.14, align: "right" },
      ],
      rows,
      "Trades",
    );
  }

  // Key stats: only values that mean something for a single day
  const planned = report.trades.map((t) => t.plannedR).filter((n): n is number => n !== null);
  const stat = (label: string, value: string | null, color?: string) =>
    value === null || value === "–" ? [] : [{ label, value, color }];
  const stats = [
    ...stat("Gross P&L", money(m.grossPnl, true), pnlColor(m.grossPnl)),
    ...stat("Fees", money(m.fees)),
    ...(m.wins > 0 ? stat("Largest win", money(m.largestWin, true), COLORS.profitGreen) : []),
    ...(m.losses > 0 ? stat("Largest loss", money(m.largestLoss), COLORS.lossRed) : []),
    ...stat("Average win", m.avgWin === null ? null : money(m.avgWin), COLORS.profitGreen),
    ...stat("Average loss", m.avgLoss === null ? null : money(m.avgLoss), COLORS.lossRed),
    ...(m.maxDrawdown > 0 ? stat("Max drawdown", money(m.maxDrawdown)) : []),
    ...stat("Average duration", m.avgDurationMs === null ? null : formatDuration(m.avgDurationMs)),
    ...stat("Volume", formatPrecision(m.totalVolume)),
    ...stat("Avg realized R", m.avgRealizedR === null ? null : formatR(m.avgRealizedR, true)),
    ...stat(
      "Avg planned R",
      planned.length ? formatR(planned.reduce((s, n) => s + n, 0) / planned.length) : null,
    ),
    ...(m.openTrades > 0 ? stat("Open trades", String(m.openTrades)) : []),
  ];
  if (stats.length) {
    b.sectionLabel("Key statistics", undefined, 60);
    b.kv(stats);
  }

  if (report.note?.trim()) {
    b.sectionLabel(
      "Day note",
      report.noteUpdatedAt ? `Last saved ${formatStamp(report.noteUpdatedAt, tz)}` : undefined,
    );
    b.addMarkdown(report.note);
    if (report.scope.filters.accounts) {
      b.y += 4;
      b.addText(
        "The day note is shared across all accounts, even though this report is filtered to selected accounts.",
        SIZE.caption,
        COLORS.textMuted,
      );
    }
  }

  const docs = report.attachments.filter((a) => !a.mime.startsWith("image/"));
  if (docs.length) addDocumentTable(b, `Documents (${docs.length})`, docs);
}

function addTradePage(
  b: PageLayoutBuilder,
  tz: string,
  trade: DailyReportTrade,
  images: Map<string, NormalizedImage>,
) {
  const cur = trade.currency;
  const money = (n: number | null | undefined, signed = false) => formatMoney(n, cur, { signed });
  const price = priceFormatter(trade);
  const open = trade.status === "open";

  b.startPage(
    "trade",
    `Trade ${trade.symbol} (${trade.status.toUpperCase()})`,
    trade.key,
    `trade-${trade.key}-p1`,
  );

  // Header: symbol + pills left, net P&L right
  b.text(MARGIN_LEFT, b.y, trade.symbol, SIZE.title, COLORS.textMain, {
    bold: true,
    maxWidth: 260,
  });
  const px = MARGIN_LEFT + b.width(trade.symbol, SIZE.title, true) + 12;
  const sideW = b.pill(px, b.y + 8, trade.direction.toUpperCase(), TONES.flat);
  b.pill(px + sideW + 5, b.y + 8, statusLabel(trade.status), statusTone(trade.status));
  b.text(
    MARGIN_LEFT + USABLE_WIDTH,
    b.y,
    open ? "Open" : money(trade.netPnl, true),
    SIZE.title,
    open ? COLORS.textMain : pnlColor(trade.netPnl),
    {
      bold: true,
      align: "right",
      maxWidth: 240,
    },
  );
  b.text(MARGIN_LEFT + USABLE_WIDTH, b.y + 28, "Net P&L", SIZE.caption, COLORS.textMuted, {
    align: "right",
  });
  b.y += 38;

  // Subline: account · times · rating · reviewed
  const o = zoned(trade.openedAt, tz);
  const c = zoned(trade.closedAt, tz);
  let span = "";
  if (o) {
    span = !c
      ? `${o.hm} – open`
      : o.date === c.date
        ? `${o.hm} – ${c.hm}`
        : `${o.date} ${o.hm} – ${c.date} ${c.hm}`;
    if (trade.durationMs !== null) span += ` (${formatDuration(trade.durationMs)})`;
  }
  const sub = [
    trade.accountName,
    span,
    trade.rating !== null && trade.rating >= 1 ? `Rating ${trade.rating}/5` : "",
    trade.reviewedAt ? "Reviewed" : "",
  ].filter(Boolean);
  b.addText(sub.join(" · "), SIZE.body, COLORS.textMuted);
  b.y += 8;
  b.hline(b.y, MARGIN_LEFT, MARGIN_LEFT + USABLE_WIDTH);
  b.y += 14;

  // Stat tiles: core group, then only the risk / planning values that are actually set
  const exc = trade.excursions;
  const tile = (label: string, value: string | null, color?: string): Tile[] =>
    value === null || value === "–" ? [] : [{ label, value, color }];
  b.tiles([
    ...tile("Entry", price(trade.avgEntry)),
    ...tile("Exit", trade.avgExit === null ? null : price(trade.avgExit)),
    ...tile("Quantity", formatPrecision(trade.quantity)),
    ...tile("Gross P&L", money(trade.grossPnl, true), pnlColor(trade.grossPnl)),
    ...tile("Fees", money(trade.fees)),
    ...tile(
      "Return",
      trade.netReturnOnEntry === null
        ? null
        : `${trade.netReturnOnEntry > 0 ? "+" : ""}${formatPercent(trade.netReturnOnEntry)}`,
      pnlColor(trade.netReturnOnEntry),
    ),
  ]);
  b.tiles([
    ...tile("Stop loss", trade.stopLoss === null ? null : price(trade.stopLoss)),
    ...tile("Profit target", trade.profitTarget === null ? null : price(trade.profitTarget)),
    ...tile("Risk", trade.riskAmount === null ? null : money(trade.riskAmount)),
    ...tile("Planned R", trade.plannedR === null ? null : formatR(trade.plannedR)),
    ...tile(
      "Realized R",
      trade.realizedR === null ? null : formatR(trade.realizedR, true),
      pnlColor(trade.realizedR),
    ),
    ...tile(
      "Target outcome",
      trade.targetHit === "profit_target"
        ? "Target hit"
        : trade.targetHit === "stop_loss"
          ? "Stop hit"
          : null,
    ),
    ...tile(
      "Multiplier",
      trade.contractMultiplier !== null && trade.contractMultiplier !== 1
        ? formatPrecision(trade.contractMultiplier)
        : null,
    ),
    ...tile("Open quantity", trade.openQuantity > 0 ? formatPrecision(trade.openQuantity) : null),
    ...tile("MAE", exc?.mae == null ? null : money(exc.mae), COLORS.lossRed),
    ...tile("MFE", exc?.mfe == null ? null : money(exc.mfe), COLORS.profitGreen),
  ]);
  if (exc && (exc.mae !== null || exc.mfe !== null)) {
    b.addText(
      `MAE / MFE from ${exc.provider} · ${exc.sampledBars} bars (${exc.resolution}) · fetched ${formatStamp(exc.fetchedAt, tz)}`,
      SIZE.caption,
      COLORS.textMuted,
    );
    b.y += 6;
  }

  if (trade.tags.length) b.pillRow("Tags", trade.tags, TONES.info);
  if (trade.mistakes.length) b.pillRow("Mistakes", trade.mistakes, TONES.loss);

  if (trade.playbook) {
    b.sectionLabel("Playbook", trade.playbook.name, 40);
    if (trade.playbook.description) {
      b.addText(trade.playbook.description, SIZE.body, COLORS.textMuted);
      b.y += 6;
    }
    b.table(
      [
        { header: "Rule", w: 0.8 },
        { header: "Status", w: 0.2, align: "right" },
      ],
      trade.playbook.rules.map((r): Cell[] => [
        r.rule,
        r.followed === true
          ? { text: "Followed", color: COLORS.profitGreen, bold: true }
          : r.followed === false
            ? { text: "Not followed", color: COLORS.lossRed, bold: true }
            : { text: "Not assessed", color: COLORS.textMuted },
      ]),
      "Rules",
    );
  }

  if (trade.runningPnl.length > 0) {
    b.chart({ title: "Running P&L", points: trade.runningPnl, currency: cur, h: 110 });
  }

  if (trade.executions.length > 0) {
    const dates = new Set(trade.executions.map((e) => zoned(e.executedAt, tz)?.date));
    const multiDay = dates.size > 1;
    const withSource = new Set(trade.executions.map((e) => e.source)).size > 1;
    b.sectionLabel("Executions", `${trade.executions.length} fills`, 60);
    b.table(
      [
        { header: "Time", w: multiDay ? 0.28 : 0.2 },
        { header: "Side", w: 0.12 },
        { header: "Qty", w: 0.16, align: "right" },
        { header: "Price", w: 0.2, align: "right" },
        { header: "Fee", w: 0.16, align: "right" },
        ...(withSource ? [{ header: "Source", w: 0.16 } as Col] : []),
      ],
      trade.executions.map((e): Cell[] => {
        const z = zoned(e.executedAt, tz);
        const buy = e.side === "buy";
        return [
          z ? (multiDay ? `${z.date} ${z.hms}` : z.hms) : e.executedAt,
          { text: buy ? "Buy" : "Sell", color: buy ? COLORS.profitGreen : COLORS.lossRed },
          formatPrecision(e.quantity),
          price(e.price),
          money(e.fee),
          ...(withSource ? [e.source] : []),
        ];
      }),
      "Executions",
    );
  }

  if (trade.notes?.trim()) {
    b.sectionLabel("Notes", undefined, 100);
    b.addMarkdown(trade.notes);
  }

  // Documents sit above the AI reviews: a short table, so it rarely lands alone on a page.
  const docs = trade.attachments.filter((a) => !a.mime.startsWith("image/"));
  if (docs.length) addDocumentTable(b, `Documents (${docs.length})`, docs);

  if (trade.aiReviews.length > 0) {
    b.sectionLabel("AI reviews", undefined, 80);
    for (const rev of trade.aiReviews) {
      b.ensureSpace(60, "AI review");
      b.beginBackdrop(TONES.info.bg);
      b.x0 = MARGIN_LEFT + 12;
      b.w = USABLE_WIDTH - 24;
      b.y += 10;
      b.text(
        b.x0,
        b.y,
        `${rev.provider} · ${rev.model} · ${formatStamp(rev.createdAt, tz).slice(0, 10)}`,
        SIZE.caption,
        COLORS.navyBrand,
        { bold: true, maxWidth: b.w },
      );
      b.y += 15;
      b.addMarkdown(rev.content);
      b.y += 6;
      b.closeBackdrop();
      b.x0 = MARGIN_LEFT;
      b.w = USABLE_WIDTH;
      b.y += 12;
    }
  }

  for (const att of trade.attachments.filter((a) => a.mime.startsWith("image/"))) {
    const norm = images.get(att.id);
    if (!norm) continue;
    b.startPage(
      "screenshot",
      `Screenshot: ${att.name} (Trade ${trade.symbol})`,
      trade.key,
      `trade-${trade.key}-screenshot-${att.id}`,
    );
    b.sectionLabel(`Screenshot · ${trade.symbol} ${statusLabel(trade.status)}`, undefined, 100);
    addScreenshotBody(
      b,
      att.name,
      norm,
      `${att.name} · ${formatFileSize(att.size)} · ${att.mime} · uploaded ${formatStamp(att.createdAt, tz)}`,
    );
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
  const b = new PageLayoutBuilder(memoizeMeasure(measure), report.timeZone);

  addOverview(b, report);

  for (const att of report.attachments.filter((a) => a.mime.startsWith("image/"))) {
    const norm = normalizedImages.get(att.id);
    if (!norm) continue;
    b.startPage(
      "screenshot",
      `Screenshot: ${att.name} (Day)`,
      undefined,
      `daily-screenshot-${att.id}`,
    );
    b.sectionLabel("Day screenshot", undefined, 100);
    addScreenshotBody(
      b,
      att.name,
      norm,
      `${att.name} · ${formatFileSize(att.size)} · ${att.mime} · uploaded ${formatStamp(att.createdAt, report.timeZone)}`,
    );
  }

  for (const trade of report.trades) addTradePage(b, report.timeZone, trade, normalizedImages);

  b.finalizeFooters(
    `Sumi · Daily report · ${report.date}`,
    `Exported ${formatStamp(report.exportedAt, report.timeZone)} (${report.timeZone})`,
  );
  return b.pages;
}

/** Date (YYYY-MM-DD, report time zone) a single-trade report is filed under. */
export function tradeReportDate({ trade, timeZone }: TradeReport): string {
  return zoned(trade.closedAt ?? trade.openedAt, timeZone)?.date ?? "trade";
}

/** Single-trade export: the same trade page(s) as the day report, without the overview. */
export function buildTradeReportLayout(
  report: TradeReport,
  normalizedImages: Map<string, NormalizedImage>,
  measure: MeasureFn = defaultMeasure,
): ReportPageLayout[] {
  const b = new PageLayoutBuilder(memoizeMeasure(measure), report.timeZone);
  addTradePage(b, report.timeZone, report.trade, normalizedImages);
  b.finalizeFooters(
    `Sumi · Trade report · ${report.trade.symbol} · ${tradeReportDate(report)}`,
    `Exported ${formatStamp(report.exportedAt, report.timeZone)} (${report.timeZone})`,
  );
  return b.pages;
}
