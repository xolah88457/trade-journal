import { and, asc, eq, inArray, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { matchesFilters, type AnalysisFilters, type AnnotatedTrade } from "@luxalgo/journal-core";
import { getTimeZone, getMultipliers, getJournalDefaults } from "./settings";
import { db, trades } from "@/db";

export type TradeFilters = AnalysisFilters & { accountIds?: string[] };

export type TradeRow = typeof trades.$inferSelect;

export const parseJsonArray = (value: string | null | undefined): string[] => {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
};

const context = () => ({ multipliers: getMultipliers(), defaults: getJournalDefaults() });
export const rowToTrade = (row: TradeRow, config = context()): AnnotatedTrade => {
  const multiplier = config.multipliers[row.symbol];
  const defaults = config.defaults;
  const missingMultiplier =
    multiplier == null && ["futures", "option", "forex", "cfd"].includes(row.assetClass ?? "");
  const notional = missingMultiplier
    ? 0
    : Math.abs(row.avgEntry * row.quantity * (multiplier ?? 1));
  const tolerance =
    defaults.breakevenMode === "percent"
      ? (notional * defaults.breakeven) / 100
      : defaults.breakeven;
  const status =
    row.status === "open"
      ? "open"
      : Math.abs(row.netPnl) <= Math.max(1e-9, tolerance)
        ? "breakeven"
        : row.netPnl > 0
          ? "win"
          : "loss";
  return {
    key: row.key,
    accountId: row.accountId,
    symbol: row.symbol,
    assetClass: (row.assetClass ?? undefined) as AnnotatedTrade["assetClass"],
    direction: row.direction,
    status,
    contractMultiplier: multiplier,
    openedAt: row.openedAt,
    closedAt: row.closedAt ?? undefined,
    quantity: row.quantity,
    openQuantity: row.openQuantity,
    avgEntry: row.avgEntry,
    avgExit: row.avgExit ?? undefined,
    grossPnl: row.grossPnl,
    fees: row.fees,
    netPnl: row.netPnl,
    executionCount: row.executionCount,
    executionIds: parseJsonArray(row.executionIdsJson),
    exits: JSON.parse(row.exitsJson) as AnnotatedTrade["exits"],
    durationMs: row.durationMs ?? undefined,
    annotations: {
      tags: parseJsonArray(row.tagsJson),
      mistakes: parseJsonArray(row.mistakesJson),
      playbook: row.playbookId ?? undefined,
      rating: row.rating ?? undefined,
      stopLoss: row.stopLoss ?? undefined,
      profitTarget: row.profitTarget ?? undefined,
      reviewed: row.reviewedAt !== null,
    },
  };
};

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const shiftDay = (day: string, days: number): string | null => {
  if (!DAY_PATTERN.test(day)) return null;
  const time = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== day) return null;
  return new Date(time + days * 86_400_000).toISOString().slice(0, 10);
};
const splitList = (value: string) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

/**
 * SQL conditions that can only exclude rows the exact predicate (matchesFilters)
 * would exclude anyway. Anything involving time zones, unicode case folding or
 * computed values is widened here and re-checked in JS.
 */
const narrowingConditions = (filters: AnalysisFilters): Array<SQL | undefined> => {
  const conditions: Array<SQL | undefined> = [];
  // Day keys are calendar days in the user's zone (UTC-12..UTC+14), so a UTC
  // timestamp range widened by a couple of days on each side is a safe superset.
  const lower = filters.from ? shiftDay(filters.from, -2) : null;
  const upper = filters.to ? shiftDay(filters.to, 3) : null;
  if (lower || upper) {
    const within = (column: SQL) =>
      and(
        lower ? sql`${column} >= ${lower}` : undefined,
        upper ? sql`${column} < ${upper}` : undefined,
      );
    conditions.push(
      or(
        and(isNotNull(trades.closedAt), within(sql`${trades.closedAt}`)),
        and(isNull(trades.closedAt), within(sql`${trades.openedAt}`)),
      ),
    );
  }
  if (filters.status === "open") conditions.push(eq(trades.status, "open"));
  else if (["closed", "win", "loss", "breakeven"].includes(filters.status ?? ""))
    conditions.push(ne(trades.status, "open"));
  if (filters.symbol) {
    const symbols = splitList(filters.symbol.toUpperCase());
    // SQLite folds ASCII case only; rows with other characters always go to the JS check.
    if (symbols.length && symbols.every((symbol) => /^[\x20-\x7e]+$/.test(symbol)))
      conditions.push(
        or(
          sql`upper(${trades.symbol}) IN (${sql.join(
            symbols.map((symbol) => sql`${symbol}`),
            sql`, `,
          )})`,
          sql`${trades.symbol} GLOB '*[^ -~]*'`,
        ),
      );
  }
  if (filters.reviewed)
    conditions.push(
      filters.reviewed === "yes" ? isNotNull(trades.reviewedAt) : isNull(trades.reviewedAt),
    );
  return conditions;
};

/**
 * Narrow identity, status and date fields in SQL before decoding rows. The core
 * predicate remains authoritative for timezone, risk and breakeven semantics.
 */
export const queryTrades = (
  filters: TradeFilters = {},
): { rows: TradeRow[]; trades: AnnotatedTrade[] } => {
  const effective = { ...filters, accounts: filters.accounts ?? filters.accountIds?.join(",") };
  const accountIds = effective.accounts
    ?.split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const all = db
    .select()
    .from(trades)
    .where(
      and(
        accountIds?.length ? inArray(trades.accountId, accountIds) : undefined,
        effective.playbookId ? eq(trades.playbookId, effective.playbookId) : undefined,
        effective.direction
          ? eq(trades.direction, effective.direction as "long" | "short")
          : undefined,
        effective.assetClass ? eq(trades.assetClass, effective.assetClass) : undefined,
        ...narrowingConditions(effective),
      ),
    )
    .orderBy(asc(trades.openedAt), asc(sql`${trades}.rowid`))
    .all();
  const timeZone = getTimeZone();
  const config = context();
  const pairs = all
    .map((row) => ({ row, trade: rowToTrade(row, config) }))
    .filter(({ trade }) => matchesFilters(trade, effective, timeZone));
  return {
    rows: pairs.map(({ row, trade }) => ({ ...row, status: trade.status })),
    trades: pairs.map((p) => p.trade),
  };
};

export const getTradeByKey = (key: string): TradeRow | undefined =>
  db.select().from(trades).where(eq(trades.key, key)).get();

const chronological = (
  a: { openedAt: string; key: string },
  b: { openedAt: string; key: string },
) => {
  const time = Date.parse(a.openedAt) - Date.parse(b.openedAt);
  return time || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
};

/** Navigate chronologically within the active filters, with a stable tie-break for equal entries. */
export const getAdjacentTradeKeys = (
  currentKey: string,
  filters: TradeFilters = {},
  accountId?: string,
) => {
  const filtered = Object.values(filters).some(Boolean);
  // Without filters only key and entry time are needed, so skip decoding full rows.
  const ordered = filtered
    ? queryTrades(filters)
        .trades.filter((trade) => !accountId || trade.accountId === accountId)
        .map(({ key, openedAt }) => ({ key, openedAt }))
    : db
        .select({ key: trades.key, openedAt: trades.openedAt })
        .from(trades)
        .where(accountId ? eq(trades.accountId, accountId) : undefined)
        .all();
  ordered.sort(chronological);
  const index = ordered.findIndex((trade) => trade.key === currentKey);
  return {
    prevKey: index > 0 ? (ordered[index - 1]?.key ?? null) : null,
    nextKey: index >= 0 ? (ordered[index + 1]?.key ?? null) : null,
    position: index >= 0 ? index + 1 : null,
    total: ordered.length,
  };
};
