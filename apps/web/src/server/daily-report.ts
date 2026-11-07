import { and, asc, eq } from "drizzle-orm";
import {
  FILTER_KEYS,
  computeMetrics,
  dayKeyOf,
  intradayCurve,
  netReturnOnEntry,
  plannedR,
  tradeR,
  tradeRisk,
  type AnalysisFilters,
  type AnnotatedTrade,
  type FilterKey,
} from "@luxalgo/journal-core";
import {
  accounts,
  attachments,
  db,
  executions,
  journalDays,
  playbooks,
  tradeRuleChecks,
  trades,
} from "@/db";
import { hitTradeTarget } from "@/lib/trade-targets";
import { describeFilters } from "@/lib/filter-description";
import { listExecutions } from "@/server/executions";
import { nowIso } from "@/server/ids";
import { savedEstimates } from "@/server/market-data/estimates";
import { getTimeZone } from "@/server/settings";
import { queryTrades, type TradeRow } from "@/server/trades-query";
import { RequestError, requireValue } from "@/server/api";
import { listTradeAiReviews } from "@/server/ai-review-history";
import type {
  DailyReport,
  DailyReportScope,
  DailyReportTrade,
  ReportAttachment,
  ReportCurvePoint,
  ReportExecution,
  ReportExcursions,
  ReportPlaybook,
} from "@/lib/daily-report-types";

export function isValidCalendarDate(date: string): boolean {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [yStr, mStr, dStr] = date.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  const d = Number(dStr);
  if (y < 1000 || y > 9999 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function parseAndValidateDailyFilters(searchParams: URLSearchParams): AnalysisFilters {
  const filters: AnalysisFilters = {};
  for (const [key, value] of searchParams.entries()) {
    requireValue(FILTER_KEYS.includes(key as FilterKey), `Unknown filter: "${key}"`);
    const trimmed = value.trim();
    requireValue(trimmed.length > 0 && trimmed.length <= 4096, `Invalid ${key} filter`);

    if (key === "direction") {
      requireValue(
        ["long", "short"].includes(trimmed),
        `Invalid direction filter: must be long or short`,
      );
    } else if (key === "status") {
      requireValue(
        ["closed", "open", "win", "loss", "breakeven"].includes(trimmed),
        `Invalid status filter`,
      );
    } else if (key === "assetClass") {
      requireValue(
        ["equity", "futures", "forex", "option", "crypto", "cfd", "other"].includes(trimmed),
        `Invalid assetClass filter`,
      );
    } else if (key === "reviewed") {
      requireValue(["yes", "no"].includes(trimmed), `Invalid reviewed filter: must be yes or no`);
    } else if (key === "from" || key === "to") {
      requireValue(
        isValidCalendarDate(trimmed),
        `Invalid ${key} filter: must be a valid calendar YYYY-MM-DD`,
      );
    } else if (/^(entry|exit)(After|Before)$/.test(key)) {
      requireValue(
        /^([01]\d|2[0-3]):[0-5]\d$/.test(trimmed),
        `Invalid ${key} filter: must be HH:mm`,
      );
    } else if (/(Min|Max)$/.test(key)) {
      requireValue(
        /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed) &&
          Number.isFinite(Number(trimmed)),
        `Invalid ${key} filter: must be a valid number`,
      );
    } else if (key === "weekdays") {
      requireValue(
        trimmed.split(",").every((d) => /^[0-6]$/.test(d.trim())),
        `Invalid weekdays filter: must be comma-separated digits 0-6`,
      );
    } else if (key === "accounts") {
      const ids = trimmed
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      requireValue(ids.length > 0, `Invalid accounts filter`);
      const existingAccounts = db.select({ id: accounts.id }).from(accounts).all();
      const existingIds = new Set(existingAccounts.map((a) => a.id));
      for (const id of ids) {
        requireValue(existingIds.has(id), `Account "${id}" not found`);
      }
    } else if (key === "playbookId") {
      const book = db
        .select({ id: playbooks.id })
        .from(playbooks)
        .where(eq(playbooks.id, trimmed))
        .get();
      requireValue(book !== undefined, `Strategy "${trimmed}" not found`);
    }

    filters[key as FilterKey] = trimmed;
  }

  if (filters.from && filters.to) {
    requireValue(filters.from <= filters.to, "From date must not be after To date");
  }

  for (const minKey of FILTER_KEYS.filter((k) => k.endsWith("Min"))) {
    const maxKey = minKey.replace(/Min$/, "Max") as FilterKey;
    if (filters[minKey] && filters[maxKey]) {
      requireValue(
        Number(filters[minKey]) <= Number(filters[maxKey]),
        `Invalid ${minKey.replace(/Min$/, "")} range: min cannot exceed max`,
      );
    }
  }

  return filters;
}

export function computeTradeRunningPnl(
  trade: {
    openedAt: string;
    fees: number;
    exits: { executionId: string; grossPnl: number; quantity: number }[];
  },
  times: Map<string, string>,
): ReportCurvePoint[] {
  const points: ReportCurvePoint[] = [{ t: trade.openedAt, cumNetPnl: 0 }];
  if (trade.exits.length === 0) return points;

  const totalExitQty = trade.exits.reduce((total, exit) => total + exit.quantity, 0);
  const exitEvents = trade.exits
    .map((exit) => ({
      t: times.get(exit.executionId) ?? trade.openedAt,
      pnl: exit.grossPnl - (totalExitQty > 0 ? trade.fees * (exit.quantity / totalExitQty) : 0),
    }))
    .sort((a, b) => Date.parse(a.t) - Date.parse(b.t));

  const exitPoints: ReportCurvePoint[] = [];
  let cum = 0;
  for (const event of exitEvents) {
    cum += event.pnl;
    const last = exitPoints[exitPoints.length - 1];
    if (last && last.t === event.t) {
      last.cumNetPnl = cum;
    } else {
      exitPoints.push({ t: event.t, cumNetPnl: cum });
    }
  }
  return [{ t: trade.openedAt, cumNetPnl: 0 }, ...exitPoints];
}

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

export async function getDailyReport(
  date: string,
  filters: AnalysisFilters = {},
): Promise<DailyReport> {
  requireValue(isValidCalendarDate(date), "date must be a valid calendar YYYY-MM-DD");

  const timeZone = getTimeZone();
  const { rows, trades: queriedTrades } = queryTrades(filters);

  // Day semantics: closedAt in configured timezone matches date, open trades excluded.
  const dayTradePairs: { trade: AnnotatedTrade; row: TradeRow }[] = [];
  for (let i = 0; i < queriedTrades.length; i++) {
    const trade = queriedTrades[i];
    const row = rows[i];
    if (trade && row && trade.closedAt && dayKeyOf(trade.closedAt, timeZone) === date) {
      dayTradePairs.push({ trade, row });
    }
  }

  // Deterministic trade sequence: closedAt then key
  dayTradePairs.sort((a, b) => {
    const cmp = (a.trade.closedAt ?? "").localeCompare(b.trade.closedAt ?? "");
    if (cmp !== 0) return cmp;
    return a.trade.key.localeCompare(b.trade.key);
  });

  const dayTrades = dayTradePairs.map((p) => p.trade);

  // Collect needed fill IDs for day trades only (avoid scanning entire account histories)
  const accountExecutionIds = new Map<string, Set<string>>();
  for (const trade of dayTrades) {
    let set = accountExecutionIds.get(trade.accountId);
    if (!set) {
      set = new Set<string>();
      accountExecutionIds.set(trade.accountId, set);
    }
    for (const id of trade.executionIds) {
      set.add(id);
    }
  }

  const times = new Map<string, string>();
  const fillsByAccount = new Map<string, Map<string, typeof executions.$inferSelect>>();
  for (const [accountId, idsSet] of accountExecutionIds) {
    const fills = listExecutions(accountId, [...idsSet]);
    const accountFills = new Map<string, typeof executions.$inferSelect>();
    for (const fill of fills) {
      times.set(fill.id, fill.executedAt);
      accountFills.set(fill.id, fill);
    }
    fillsByAccount.set(accountId, accountFills);
  }

  const metrics = computeMetrics(dayTrades, { timeZone });
  const intraday: ReportCurvePoint[] = intradayCurve(dayTrades, times, date, timeZone);

  // Scope: accounts, currencies, label
  // When unfiltered, derive represented accounts from actual dayTrades to avoid leaking private/archived accounts
  const allAccounts = db.select().from(accounts).all();
  const accountMap = new Map(allAccounts.map((a) => [a.id, a]));
  let inScopeAccounts: typeof allAccounts;
  if (filters.accounts) {
    const requestedAccountIds = filters.accounts
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    inScopeAccounts = allAccounts.filter((a) => requestedAccountIds.includes(a.id));
  } else {
    const representedAccountIds = new Set(dayTrades.map((t) => t.accountId));
    inScopeAccounts = allAccounts.filter((a) => representedAccountIds.has(a.id));
  }
  const accountNames = inScopeAccounts.map((a) => a.name).sort();
  const currencies = [...new Set(inScopeAccounts.map((a) => a.currency))].sort();

  const allPlaybooks = db.select().from(playbooks).all();
  const playbookMap = new Map(allPlaybooks.map((p) => [p.id, p]));
  const label = describeFilters(filters, allAccounts, allPlaybooks);

  const scope: DailyReportScope = {
    label,
    filters: filters as Record<string, string>,
    accountNames,
    currencies,
  };

  // Day note & day attachments
  const journalDay = db.select().from(journalDays).where(eq(journalDays.date, date)).get();
  const note = journalDay?.note ?? "";
  const noteUpdatedAt = journalDay?.updatedAt ?? null;

  const dayAttachments: ReportAttachment[] = db
    .select({
      id: attachments.id,
      name: attachments.name,
      mime: attachments.mime,
      size: attachments.size,
      createdAt: attachments.createdAt,
    })
    .from(attachments)
    .where(and(eq(attachments.ownerType, "day"), eq(attachments.ownerId, date)))
    .orderBy(asc(attachments.createdAt), asc(attachments.id))
    .all();

  // Cached excursions only, no live network or quotes
  const cachedExcursions = savedEstimates(dayTrades);

  // Build each visible trade
  const reportTrades: DailyReportTrade[] = [];
  for (const { trade, row } of dayTradePairs) {
    const acc = accountMap.get(trade.accountId);
    const accountName = acc?.name ?? "";
    const currency = acc?.currency ?? "USD";

    // Playbook checklist
    let playbook: ReportPlaybook | null = null;
    if (row.playbookId) {
      const book = playbookMap.get(row.playbookId);
      if (book) {
        const rules = [...new Set(parseJsonArray(book.rulesJson))];
        const checks = db
          .select()
          .from(tradeRuleChecks)
          .where(
            and(eq(tradeRuleChecks.tradeKey, trade.key), eq(tradeRuleChecks.playbookId, book.id)),
          )
          .all();
        playbook = {
          id: book.id,
          name: book.name,
          description: book.description,
          rules: rules.map((rule) => ({
            rule,
            followed: checks.find((c) => c.rule === rule)?.followed ?? null,
          })),
        };
      }
    }

    // Executions for this trade (from preloaded map)
    const accountFills = fillsByAccount.get(trade.accountId);
    const fills = trade.executionIds
      .map((id) => accountFills?.get(id))
      .filter((f): f is typeof executions.$inferSelect => Boolean(f));
    fills.sort((a, b) => a.executedAt.localeCompare(b.executedAt) || a.id.localeCompare(b.id));
    const executionsReport: ReportExecution[] = fills.map((f) => ({
      id: f.id,
      executedAt: f.executedAt,
      side: f.side as "buy" | "sell",
      quantity: f.quantity,
      price: f.price,
      fee: f.fee,
      source: f.source,
    }));

    // Running PnL over all realized exits + fees
    const tradeFillsTimes = new Map(fills.map((f) => [f.id, f.executedAt]));
    const runningPnl = computeTradeRunningPnl(trade, tradeFillsTimes);

    // Trade attachments (metadata only)
    const tradeAttachments: ReportAttachment[] = db
      .select({
        id: attachments.id,
        name: attachments.name,
        mime: attachments.mime,
        size: attachments.size,
        createdAt: attachments.createdAt,
      })
      .from(attachments)
      .where(and(eq(attachments.ownerType, "trade"), eq(attachments.ownerId, trade.key)))
      .orderBy(asc(attachments.createdAt), asc(attachments.id))
      .all();

    // AI reviews from helper
    const rawAiReviews = await listTradeAiReviews(trade.key);
    const aiReviews = (rawAiReviews ?? []).map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      content: r.content,
      provider: r.provider,
      model: r.model,
    }));

    // Cached excursions
    const cached = cachedExcursions.get(trade.key);
    const excursions: ReportExcursions | null = cached
      ? {
          mae: cached.estimate.mae,
          mfe: cached.estimate.mfe,
          sampledBars: cached.estimate.sampledBars,
          resolution: cached.resolution,
          provider: cached.provider,
          fetchedAt: cached.fetchedAt,
        }
      : null;

    const stopLoss = trade.annotations?.stopLoss ?? null;
    const profitTarget = trade.annotations?.profitTarget ?? null;
    const targetHit = hitTradeTarget(trade.status, trade.avgExit, stopLoss, profitTarget);
    const contractMultiplier =
      trade.contractMultiplier ??
      (["futures", "option", "forex", "cfd"].includes(trade.assetClass ?? "") ? null : 1);

    reportTrades.push({
      key: trade.key,
      symbol: trade.symbol,
      accountId: trade.accountId,
      accountName,
      currency,
      assetClass: trade.assetClass ?? null,
      direction: trade.direction,
      status: trade.status,
      openedAt: trade.openedAt,
      closedAt: trade.closedAt ?? null,
      durationMs: trade.durationMs ?? null,
      quantity: trade.quantity,
      openQuantity: trade.openQuantity,
      contractMultiplier,
      avgEntry: trade.avgEntry,
      grossPnl: trade.grossPnl,
      fees: trade.fees,
      netPnl: trade.netPnl,
      avgExit: trade.avgExit ?? null,
      netReturnOnEntry: netReturnOnEntry(trade),
      riskAmount: tradeRisk(trade),
      plannedR: plannedR(trade),
      realizedR: tradeR(trade),
      stopLoss,
      profitTarget,
      targetHit,
      rating: trade.annotations?.rating ?? null,
      reviewedAt: row.reviewedAt ?? null,
      tags: trade.annotations?.tags ?? [],
      mistakes: trade.annotations?.mistakes ?? [],
      notes: row.notes ?? "",
      playbook,
      executions: executionsReport,
      runningPnl,
      attachments: tradeAttachments,
      aiReviews,
      excursions,
    });
  }

  return {
    date,
    exportedAt: nowIso(),
    timeZone,
    scope,
    metrics,
    profitFactorIsInfinite: metrics.profitFactorIsInfinite,
    intraday,
    note,
    noteUpdatedAt,
    attachments: dayAttachments,
    trades: reportTrades,
  };
}
