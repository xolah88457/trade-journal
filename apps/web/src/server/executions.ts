import { and, eq, inArray } from "drizzle-orm";
import type { ExecutionSource } from "@luxalgo/journal-core";
import { positionFillProblem, type ImportedExecution } from "@luxalgo/journal-importers";
import { db, executions, accounts, trades } from "@/db";
import { executionHash, newId, nowIso } from "./ids";
import { rebuildAccount } from "./rebuild";
import { deleteTradeAiReviews } from "./ai-review-history";
import { getJournalDefaults } from "./settings";
import { defaultFee } from "@/lib/journal-defaults";
import { requireValue } from "./api";
import { positionImportErrors } from "./position-import";

export interface InsertResult {
  inserted: number;
  duplicates: number;
  /** Rows dropped because a broker or file record was unusable (sync/import only). */
  skipped: number;
  /** A few plain-language reasons for skipped rows, capped so payloads stay small. */
  skippedReasons: string[];
  /** Trade keys created or updated by this batch of executions. */
  tradeKeys?: string[];
}

const MAX_SKIP_REASONS = 5;

const isFiniteNumber = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** Plain-language reason a row can't be journaled, or null when the row is valid. */
export const executionProblem = (row: unknown, source: ExecutionSource): string | null => {
  if (!row || typeof row !== "object") return "Execution is missing.";
  const r = row as Partial<ImportedExecution>;
  const label = typeof r.symbol === "string" && r.symbol.trim() ? r.symbol.trim() : "execution";
  if (typeof r.symbol !== "string" || !r.symbol.trim()) return "An execution has no symbol.";
  if (!["buy", "sell"].includes(r.side as string)) return `${label}: side must be buy or sell.`;
  if (!isFiniteNumber(r.quantity) || r.quantity <= 0)
    return `${label}: quantity must be a finite positive number.`;
  if (!isFiniteNumber(r.price)) return `${label}: price must be a finite number.`;
  if (!isFiniteNumber(r.fee ?? 0)) return `${label}: fee must be a finite number.`;
  if (typeof r.executedAt !== "string" || !Number.isFinite(Date.parse(r.executedAt)))
    return `${label}: timestamp is missing or invalid.`;
  if (
    r.occurrence !== undefined &&
    (source === "manual" || !Number.isSafeInteger(r.occurrence) || r.occurrence < 1)
  )
    return `${label}: invalid copy number for an identical fill.`;
  if (
    r.hashQuantity !== undefined &&
    (source !== "sync" || !isFiniteNumber(r.hashQuantity) || r.hashQuantity <= r.quantity)
  )
    return `${label}: invalid reported quantity for a fill kept in part.`;
  const meta = r.importMetadata;
  const metaOk =
    !meta ||
    ((source === "import" || source === "sync") &&
      typeof meta.id === "string" &&
      meta.id.length > 0 &&
      meta.id.length <= 2000 &&
      (meta.group === undefined ||
        (typeof meta.group === "string" && meta.group.length > 0 && meta.group.length <= 2000)) &&
      Number.isSafeInteger(meta.order) &&
      meta.order >= 0 &&
      (meta.reportedGrossPnl === undefined || Number.isFinite(meta.reportedGrossPnl)) &&
      (meta.preserveFee === undefined || typeof meta.preserveFee === "boolean")) ||
    (source === "manual" &&
      Number.isSafeInteger(meta.order) &&
      meta.order >= 0 &&
      (meta.id === undefined || (typeof meta.id === "string" && meta.id.length <= 2000)));
  if (!metaOk) return `${label}: invalid imported execution metadata.`;
  const positionProblem = positionFillProblem(r as ImportedExecution);
  if (positionProblem) return positionProblem;
  return null;
};

/**
 * Split a batch into usable rows and skip reasons. Manual entry is strict: the
 * whole batch is rejected on the first bad row. Broker syncs and file imports
 * are lenient: one odd record must not fail the entire batch, so bad rows are
 * dropped and counted for the caller to report. Position-labelled histories are
 * atomic: dropping a bad fill could change which position the remaining fills close.
 */
export const partitionExecutions = (
  rows: ImportedExecution[],
  source: ExecutionSource,
): { usable: ImportedExecution[]; skipped: number; skippedReasons: string[] } => {
  const usable: ImportedExecution[] = [];
  const skippedReasons: string[] = [];
  let skipped = 0;
  for (const row of rows) {
    const problem = executionProblem(row, source);
    if (
      problem &&
      (row?.importMetadata?.position ||
        (typeof row?.importMetadata?.group === "string" &&
          row.importMetadata.group.startsWith("csv-position:")))
    )
      requireValue(false, problem);
    if (problem === null) {
      usable.push(row);
      continue;
    }
    if (source === "manual") {
      requireValue(
        false,
        "Every execution needs a symbol, buy/sell side, finite positive quantity, price, fee and valid timestamp.",
      );
    }
    skipped++;
    if (skippedReasons.length < MAX_SKIP_REASONS) skippedReasons.push(problem);
  }
  return { usable, skipped, skippedReasons };
};

interface InsertExecutionOptions {
  preserveFees?: boolean;
  stopLoss?: number | null;
  profitTarget?: number | null;
  manualTrade?: boolean;
}

/** Insert fills, rebuild trades, and attach optional manual notes and plans in one transaction. */
export const insertExecutions = (
  accountId: string,
  rows: ImportedExecution[],
  source: ExecutionSource,
  manualNotes?: string,
  options: InsertExecutionOptions = {},
): InsertResult => {
  requireValue(
    manualNotes === undefined ||
      (source === "manual" && typeof manualNotes === "string" && manualNotes.length <= 100000),
    "Manual trade notes must be at most 100,000 characters.",
  );
  if (options.stopLoss !== undefined && options.stopLoss !== null) {
    requireValue(
      Number.isFinite(options.stopLoss) && options.stopLoss > 0,
      "Planned stop loss must be a positive number.",
    );
  }
  if (options.profitTarget !== undefined && options.profitTarget !== null) {
    requireValue(
      Number.isFinite(options.profitTarget) && options.profitTarget > 0,
      "Planned take profit must be a positive number.",
    );
  }
  requireValue(
    db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, accountId)).get(),
    "Account not found.",
  );
  const { usable, skipped, skippedReasons } = partitionExecutions(rows, source);
  requireValue(
    !usable.some((row) => row.ninjaTrader || row.importMetadata?.group?.startsWith("ninjatrader")),
    "NinjaTrader fills require the reviewed import endpoint.",
  );
  let inserted = 0;
  let duplicates = 0;
  const createdAt = nowIso();
  const defaults = getJournalDefaults();
  const note = manualNotes?.trim() ? manualNotes : undefined;
  let matchedTradeKeys: string[] = [];

  db.transaction((tx) => {
    const positionErrors = positionImportErrors(accountId, usable);
    requireValue(positionErrors.length === 0, positionErrors.join(" "));
    if (source === "import") {
      const existingHashes = new Set(
        tx
          .select({ hash: executions.contentHash })
          .from(executions)
          .where(and(eq(executions.accountId, accountId), eq(executions.source, "import")))
          .all()
          .map((row) => row.hash),
      );
      for (const row of usable) {
        if (existingHashes.has(executionHash(row))) continue;
        const candidates = [row.legacyExecutedAt, row.executedAt.replace(/\.\d{3}Z$/, ".000Z")];
        requireValue(
          !candidates.some(
            (executedAt) =>
              executedAt &&
              executedAt !== row.executedAt &&
              existingHashes.has(executionHash({ ...row, executedAt })),
          ),
          "Matching imported fills have timestamps from an older parser or indistinguishable whole-second executions. Import the complete corrected history into a new journal account and compare it before retiring the old account; nothing was saved.",
        );
      }
    }
    const batchExecutionIds = new Set<string>();
    const newlyInsertedBatchIds = new Set<string>();
    for (let i = 0; i < usable.length; i++) {
      const row = usable[i]!;
      const id = newId();
      const rowWithMeta: ImportedExecution =
        options.manualTrade && source === "manual"
          ? {
              ...row,
              importMetadata: {
                id: `manual:${row.executedAt}:${i}`,
                order: i,
              },
            }
          : row;
      const contentHash = executionHash(rowWithMeta);
      const result = tx
        .insert(executions)
        .values({
          id,
          accountId,
          symbol: rowWithMeta.symbol,
          side: rowWithMeta.side,
          quantity: rowWithMeta.quantity,
          price: rowWithMeta.price,
          fee:
            rowWithMeta.importMetadata?.preserveFee || options.preserveFees
              ? rowWithMeta.fee
              : defaultFee(
                  rowWithMeta.fee,
                  rowWithMeta.quantity,
                  accountId,
                  rowWithMeta.symbol,
                  defaults,
                ),
          executedAt: rowWithMeta.executedAt,
          assetClass: rowWithMeta.assetClass ?? null,
          source,
          importMetadataJson: rowWithMeta.importMetadata
            ? JSON.stringify(rowWithMeta.importMetadata)
            : null,
          contentHash,
          createdAt,
        })
        .onConflictDoNothing()
        .run();
      if (result.changes > 0) {
        inserted++;
        batchExecutionIds.add(id);
        newlyInsertedBatchIds.add(id);
      } else {
        duplicates++;
        const existing = tx
          .select({ id: executions.id })
          .from(executions)
          .where(and(eq(executions.accountId, accountId), eq(executions.contentHash, contentHash)))
          .get();
        if (existing) batchExecutionIds.add(existing.id);
      }
    }
    if (options.manualTrade && inserted === 0) {
      requireValue(false, "Manual trade already exists in journal; nothing was saved.");
    }
    if (inserted > 0) rebuildAccount(accountId);

    // Identify trades touched by this batch of executions
    const affectedTrades = tx
      .select({
        key: trades.key,
        notes: trades.notes,
        direction: trades.direction,
        avgEntry: trades.avgEntry,
        executionIdsJson: trades.executionIdsJson,
        stopLoss: trades.stopLoss,
        profitTarget: trades.profitTarget,
      })
      .from(trades)
      .where(eq(trades.accountId, accountId))
      .all()
      .filter((trade) => {
        try {
          const ids = JSON.parse(trade.executionIdsJson) as string[];
          return ids.some((id) => batchExecutionIds.has(id));
        } catch {
          return false;
        }
      });

    matchedTradeKeys = affectedTrades.map((t) => t.key);

    if (options.manualTrade) {
      requireValue(
        affectedTrades.length === 1,
        "A new manual trade must create or affect exactly one trade.",
      );
      const touchedTrade = affectedTrades[0]!;
      let touchedIds: string[] = [];
      try {
        touchedIds = JSON.parse(touchedTrade.executionIdsJson) as string[];
      } catch {
        touchedIds = [];
      }
      const allNewlyInserted =
        touchedIds.length === newlyInsertedBatchIds.size &&
        touchedIds.every((id) => newlyInsertedBatchIds.has(id));
      requireValue(
        allNewlyInserted,
        "New manual trade cannot merge with an existing open position.",
      );
    }

    const hasSl = options.stopLoss !== undefined;
    const hasTp = options.profitTarget !== undefined;

    if (hasSl || hasTp) {
      for (const trade of affectedTrades) {
        const sl = hasSl ? options.stopLoss : trade.stopLoss;
        const tp = hasTp ? options.profitTarget : trade.profitTarget;

        if (sl != null && Number.isFinite(sl)) {
          if (trade.direction === "long") {
            requireValue(
              sl < trade.avgEntry,
              `Stop loss (${sl}) must be below entry price (${trade.avgEntry}) for a long trade.`,
            );
          } else {
            requireValue(
              sl > trade.avgEntry,
              `Stop loss (${sl}) must be above entry price (${trade.avgEntry}) for a short trade.`,
            );
          }
        }

        if (tp != null && Number.isFinite(tp)) {
          if (trade.direction === "long") {
            requireValue(
              tp > trade.avgEntry,
              `Take profit (${tp}) must be above entry price (${trade.avgEntry}) for a long trade.`,
            );
          } else {
            requireValue(
              tp < trade.avgEntry,
              `Take profit (${tp}) must be below entry price (${trade.avgEntry}) for a short trade.`,
            );
          }
        }

        const planPatch: Partial<typeof trades.$inferInsert> = {};
        if (hasSl) planPatch.stopLoss = options.stopLoss;
        if (hasTp) planPatch.profitTarget = options.profitTarget;
        tx.update(trades).set(planPatch).where(eq(trades.key, trade.key)).run();
      }
    }

    if (note) {
      for (const trade of affectedTrades) {
        // Keep prior annotations when these fills extend or close an existing position.
        // Retrying the same submission must not append the note a second time.
        if (trade.notes === note || trade.notes?.endsWith(`\n\n${note}`)) continue;
        const notes = trade.notes?.trim() ? `${trade.notes}\n\n${note}` : note;
        requireValue(
          notes.length <= 100000,
          "Combined trade notes must be at most 100,000 characters.",
        );
        tx.update(trades).set({ notes }).where(eq(trades.key, trade.key)).run();
      }
    }
  });

  return { inserted, duplicates, skipped, skippedReasons, tradeKeys: matchedTradeKeys };
};

export const deleteExecutionsForTrades = (
  accountId: string,
  executionIds: string[],
  tradeKeys?: string[],
): void => {
  if (executionIds.length === 0) return;
  if (tradeKeys && tradeKeys.length > 0) {
    deleteTradeAiReviews(tradeKeys);
  }
  db.delete(executions)
    .where(and(eq(executions.accountId, accountId), inArray(executions.id, executionIds)))
    .run();
  rebuildAccount(accountId);
};

export const listExecutions = (accountId: string, ids?: string[]) => {
  if (ids && ids.length > 0) {
    return db
      .select()
      .from(executions)
      .where(and(eq(executions.accountId, accountId), inArray(executions.id, ids)))
      .all();
  }
  return db.select().from(executions).where(eq(executions.accountId, accountId)).all();
};
