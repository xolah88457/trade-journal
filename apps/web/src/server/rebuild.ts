import { and, eq, inArray } from "drizzle-orm";
import { buildRoundTrips, type Execution, type ProfitCalcMethod } from "@luxalgo/journal-core";
import { db, executions, trades, accounts } from "@/db";
import { getMultipliers, getJournalDefaults } from "./settings";
import { defaultRisk } from "@/lib/journal-defaults";

/** Computed trade columns; the annotation columns are never part of this set. */
const COMPUTED_COLUMNS = [
  "accountId",
  "symbol",
  "assetClass",
  "direction",
  "status",
  "openedAt",
  "closedAt",
  "quantity",
  "openQuantity",
  "avgEntry",
  "avgExit",
  "grossPnl",
  "fees",
  "netPnl",
  "executionCount",
  "executionIdsJson",
  "exitsJson",
  "durationMs",
] as const satisfies readonly (keyof typeof trades.$inferSelect)[];

/**
 * Rebuild the materialized round trips for an account from its executions.
 * Computed columns are overwritten; annotation columns are untouched because
 * rows are upserted by their rebuild-stable key. Rows whose computed columns
 * already hold the computed values are not written at all. Trades whose key no
 * longer exists (their executions were deleted) are removed.
 */
export const rebuildAccount = (accountId: string): void => {
  const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  if (!account) return;

  const rows = db.select().from(executions).where(eq(executions.accountId, accountId)).all();
  const executionInputs: Execution[] = rows.map((row) => ({
    id: row.id,
    accountId: row.accountId,
    symbol: row.symbol,
    side: row.side,
    quantity: row.quantity,
    price: row.price,
    fee: row.fee,
    executedAt: row.executedAt,
    assetClass: (row.assetClass ?? undefined) as Execution["assetClass"],
    source: row.source,
    importMetadata: row.importMetadataJson ? JSON.parse(row.importMetadataJson) : undefined,
  }));

  const trips = buildRoundTrips(executionInputs, {
    method: account.profitCalcMethod as ProfitCalcMethod,
    multipliers: getMultipliers(),
  });
  const existing = new Map(
    db
      .select({
        key: trades.key,
        accountId: trades.accountId,
        symbol: trades.symbol,
        assetClass: trades.assetClass,
        direction: trades.direction,
        status: trades.status,
        openedAt: trades.openedAt,
        closedAt: trades.closedAt,
        quantity: trades.quantity,
        openQuantity: trades.openQuantity,
        avgEntry: trades.avgEntry,
        avgExit: trades.avgExit,
        grossPnl: trades.grossPnl,
        fees: trades.fees,
        netPnl: trades.netPnl,
        executionCount: trades.executionCount,
        executionIdsJson: trades.executionIdsJson,
        exitsJson: trades.exitsJson,
        durationMs: trades.durationMs,
      })
      .from(trades)
      .where(eq(trades.accountId, accountId))
      .all()
      .map((row) => [row.key, row] as const),
  );
  const obsolete = new Set(existing.keys());
  const defaults = getJournalDefaults();

  db.transaction((tx) => {
    for (const trip of trips) {
      obsolete.delete(trip.key);
      const computed = {
        accountId: trip.accountId,
        symbol: trip.symbol,
        assetClass: trip.assetClass ?? null,
        direction: trip.direction,
        status: trip.status,
        openedAt: trip.openedAt,
        closedAt: trip.closedAt ?? null,
        quantity: trip.quantity,
        openQuantity: trip.openQuantity,
        avgEntry: trip.avgEntry,
        avgExit: trip.avgExit ?? null,
        grossPnl: trip.grossPnl,
        fees: trip.fees,
        netPnl: trip.netPnl,
        executionCount: trip.executionCount,
        executionIdsJson: JSON.stringify(trip.executionIds),
        exitsJson: JSON.stringify(trip.exits),
        durationMs: trip.durationMs ?? null,
      };
      const stored = existing.get(trip.key);
      // Object.is keeps -0 and NaN differences visible, so only truly equal rows are skipped.
      if (stored && COMPUTED_COLUMNS.every((column) => Object.is(stored[column], computed[column])))
        continue;
      tx.insert(trades)
        .values({
          key: trip.key,
          ...computed,
          ...defaultRisk(trip.avgEntry, trip.direction, accountId, trip.symbol, defaults),
        })
        .onConflictDoUpdate({ target: trades.key, set: computed })
        .run();
    }
    const vanished = [...obsolete];
    // Keep each statement below SQLite's bind-parameter limit, even for long histories.
    for (let i = 0; i < vanished.length; i += 500) {
      tx.delete(trades)
        .where(
          and(eq(trades.accountId, accountId), inArray(trades.key, vanished.slice(i, i + 500))),
        )
        .run();
    }
  });
};
