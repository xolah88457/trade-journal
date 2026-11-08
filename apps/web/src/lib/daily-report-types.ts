import type { TradeMetrics } from "@luxalgo/journal-core";

export interface ReportCurvePoint {
  t: string;
  cumNetPnl: number;
}

export interface ReportAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  createdAt: string;
}

export interface ReportExecution {
  id: string;
  executedAt: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  fee: number;
  source: string;
}

export interface ReportAiReview {
  id: string;
  createdAt: string;
  content: string;
  provider: string;
  model: string;
}

export interface ReportPlaybookRule {
  rule: string;
  followed: boolean | null;
}

export interface ReportPlaybook {
  id: string;
  name: string;
  description: string;
  rules: ReportPlaybookRule[];
}

export interface ReportExcursions {
  mae: number | null;
  mfe: number | null;
  sampledBars: number;
  resolution: string;
  provider: string;
  fetchedAt: string;
}

export interface DailyReportTrade {
  key: string;
  symbol: string;
  accountId: string;
  accountName: string;
  currency: string;
  assetClass: string | null;
  direction: "long" | "short";
  status: "open" | "win" | "loss" | "breakeven";
  openedAt: string;
  closedAt: string | null;
  durationMs: number | null;
  quantity: number;
  openQuantity: number;
  contractMultiplier: number | null;
  avgEntry: number;
  grossPnl: number;
  fees: number;
  netPnl: number;
  avgExit: number | null;
  netReturnOnEntry: number | null;
  riskAmount: number | null;
  plannedR: number | null;
  realizedR: number | null;
  stopLoss: number | null;
  profitTarget: number | null;
  targetHit: "stop_loss" | "profit_target" | null;
  rating: number | null;
  reviewedAt: string | null;
  tags: string[];
  mistakes: string[];
  notes: string;
  playbook: ReportPlaybook | null;
  executions: ReportExecution[];
  runningPnl: ReportCurvePoint[];
  attachments: ReportAttachment[];
  aiReviews: ReportAiReview[];
  excursions: ReportExcursions | null;
}

export interface DailyReportScope {
  label: string;
  filters: Record<string, string>;
  accountNames: string[];
  currencies: string[];
}

export interface DailyReport {
  date: string;
  exportedAt: string;
  timeZone: string;
  scope: DailyReportScope;
  metrics: TradeMetrics;
  profitFactorIsInfinite: boolean;
  intraday: ReportCurvePoint[];
  note: string;
  noteUpdatedAt: string | null;
  attachments: ReportAttachment[];
  trades: DailyReportTrade[];
}

/** Single-trade export: the same trade shape as a day report, without the day context. */
export interface TradeReport {
  exportedAt: string;
  timeZone: string;
  trade: DailyReportTrade;
}
