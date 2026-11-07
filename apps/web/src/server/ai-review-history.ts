import { inArray, like, eq } from "drizzle-orm";
import { db, settings, trades } from "@/db";
import { newId, nowIso } from "./ids";
import { getSetting, deleteSetting } from "./settings";

export class TradeNotFoundError extends Error {
  readonly status = 404;
  constructor(tradeKey: string) {
    super(`Trade not found: ${tradeKey}`);
    this.name = "TradeNotFoundError";
  }
}

export interface SavedTradeAiReview {
  id: string;
  createdAt: string;
  content: string;
  provider: string;
  model: string;
}

export interface ExportedTradeAiReview extends SavedTradeAiReview {
  tradeKey: string;
}

const SETTING_PREFIX = "tradeAiReviews:";

export const reviewSettingKey = (tradeKey: string): string => `${SETTING_PREFIX}${tradeKey.trim()}`;

/**
 * Validates and parses raw review history JSON.
 * Returns [] ONLY when raw is absent (null/undefined).
 * Throws explicit descriptive Error on malformed JSON, non-array, or invalid items,
 * preventing silent corruption and accidental overwriting.
 * Whitelists mapped fields on output.
 */
export function parseTradeAiReviews(
  raw: string | null | undefined,
  tradeKey: string,
): SavedTradeAiReview[] {
  if (raw === null || raw === undefined) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Malformed AI review history for trade "${tradeKey}": invalid JSON`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`Malformed AI review history for trade "${tradeKey}": expected JSON array`);
  }

  const reviews: SavedTradeAiReview[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i];
    if (
      !item ||
      typeof item !== "object" ||
      typeof (item as Record<string, unknown>).id !== "string" ||
      !(item as Record<string, unknown>).id ||
      typeof (item as Record<string, unknown>).createdAt !== "string" ||
      !(item as Record<string, unknown>).createdAt ||
      typeof (item as Record<string, unknown>).content !== "string" ||
      typeof (item as Record<string, unknown>).provider !== "string" ||
      typeof (item as Record<string, unknown>).model !== "string"
    ) {
      throw new Error(
        `Malformed AI review item at index ${i} for trade "${tradeKey}": missing or invalid required fields`,
      );
    }
    const r = item as {
      id: string;
      createdAt: string;
      content: string;
      provider: string;
      model: string;
    };
    reviews.push({
      id: r.id,
      createdAt: r.createdAt,
      content: r.content,
      provider: r.provider,
      model: r.model,
    });
  }

  return reviews.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/**
 * Returns all saved AI critique reviews for a trade, ordered ascending from oldest to newest.
 * Exposes the exact contract required by other workers and the UI.
 * Throws if the underlying KV is present but corrupted.
 */
export function listTradeAiReviews(tradeKey: string): SavedTradeAiReview[] {
  if (!tradeKey || typeof tradeKey !== "string" || !tradeKey.trim()) {
    return [];
  }
  const cleanKey = tradeKey.trim();
  const raw = getSetting(reviewSettingKey(cleanKey));
  return parseTradeAiReviews(raw, cleanKey);
}

/**
 * Persists a successful AI critique for a trade.
 * Records ONLY { id, createdAt, content, provider, model }.
 * Never records prompts, system instructions, api keys, or endpoint URLs.
 *
 * Runs inside an atomic immediate DB transaction: reads, validates, appends, and writes.
 * If existing KV data is corrupted, throws an explicit error and aborts, preserving the corrupted KV.
 */
export function appendTradeAiReview(
  tradeKey: string,
  review: {
    content: string;
    provider: string;
    model: string;
    id?: string;
    createdAt?: string;
  },
  options?: {
    requireTradeExists?: boolean;
  },
): SavedTradeAiReview {
  if (!tradeKey || typeof tradeKey !== "string" || !tradeKey.trim()) {
    throw new Error("tradeKey is required to save review");
  }
  const cleanKey = tradeKey.trim();
  const key = reviewSettingKey(cleanKey);

  const entry: SavedTradeAiReview = {
    id: review.id ?? newId(),
    createdAt: review.createdAt ?? nowIso(),
    content: review.content,
    provider: review.provider,
    model: review.model,
  };

  db.transaction(
    (tx) => {
      if (options?.requireTradeExists) {
        const tradeRow = tx
          .select({ key: trades.key })
          .from(trades)
          .where(eq(trades.key, cleanKey))
          .get();
        if (!tradeRow) {
          throw new TradeNotFoundError(cleanKey);
        }
      }

      const row = tx.select().from(settings).where(eq(settings.key, key)).get();
      const current = parseTradeAiReviews(row?.value, cleanKey);

      const updated = [...current, entry].sort(
        (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
      );

      tx.insert(settings)
        .values({ key, value: JSON.stringify(updated) })
        .onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify(updated) } })
        .run();
    },
    { behavior: "immediate" },
  );

  return entry;
}

/**
 * Deletes AI review history for one or more trade keys.
 * Accepts optional tx to run atomically inside caller's existing transaction.
 */
export function deleteTradeAiReviews(
  tradeKeys: string | string[],
  tx?: {
    delete: typeof db.delete;
  },
): void {
  const keys = (Array.isArray(tradeKeys) ? tradeKeys : [tradeKeys])
    .map((k) => (typeof k === "string" ? k.trim() : ""))
    .filter(Boolean);
  if (keys.length === 0) return;

  const settingKeys = keys.map(reviewSettingKey);
  const runner = tx ?? db;
  for (let i = 0; i < settingKeys.length; i += 500) {
    runner
      .delete(settings)
      .where(inArray(settings.key, settingKeys.slice(i, i + 500)))
      .run();
  }
}

/**
 * Migrates/merges AI review history from source trade key to destination trade key,
 * deleting the source key record. Runs within caller's transaction if provided.
 */
export function migrateTradeAiReviews(
  sourceKey: string,
  destinationKey: string,
  tx?: {
    select: typeof db.select;
    insert: typeof db.insert;
    delete: typeof db.delete;
  },
): void {
  if (!sourceKey || !destinationKey || sourceKey === destinationKey) return;
  const runner = tx ?? db;
  const sourceSetting = reviewSettingKey(sourceKey);
  const destSetting = reviewSettingKey(destinationKey);

  const sourceRow = runner.select().from(settings).where(eq(settings.key, sourceSetting)).get();
  if (!sourceRow) return;

  const sourceReviews = parseTradeAiReviews(sourceRow.value, sourceKey);
  const destRow = runner.select().from(settings).where(eq(settings.key, destSetting)).get();
  const destReviews = destRow ? parseTradeAiReviews(destRow.value, destinationKey) : [];

  const map = new Map<string, SavedTradeAiReview>();
  for (const r of destReviews) map.set(r.id, r);
  for (const r of sourceReviews) map.set(r.id, r);

  const merged = Array.from(map.values()).sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );

  runner
    .insert(settings)
    .values({ key: destSetting, value: JSON.stringify(merged) })
    .onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify(merged) } })
    .run();

  runner.delete(settings).where(eq(settings.key, sourceSetting)).run();
}

/**
 * Lists all trade AI reviews across all trades for full JSON export.
 * Excludes any credentials, prompts, or sensitive settings.
 * Strict: fails clearly on corrupted data without returning unasked raw fallback formats,
 * preserving database contents unchanged.
 */
export function listAllTradeAiReviews(): ExportedTradeAiReview[] {
  const rows = db
    .select()
    .from(settings)
    .where(like(settings.key, `${SETTING_PREFIX}%`))
    .all();

  const results: ExportedTradeAiReview[] = [];
  for (const row of rows) {
    const tradeKey = row.key.slice(SETTING_PREFIX.length);
    const reviews = parseTradeAiReviews(row.value, tradeKey);
    for (const r of reviews) {
      results.push({
        tradeKey,
        id: r.id,
        createdAt: r.createdAt,
        content: r.content,
        provider: r.provider,
        model: r.model,
      });
    }
  }

  return results.sort(
    (a, b) =>
      Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.tradeKey.localeCompare(b.tradeKey),
  );
}

/**
 * Clears saved AI reviews for a trade or all trades (primarily used in tests).
 */
export function clearTradeAiReviews(tradeKey?: string): void {
  if (tradeKey && typeof tradeKey === "string" && tradeKey.trim()) {
    deleteSetting(reviewSettingKey(tradeKey));
    return;
  }
  const rows = db
    .select({ key: settings.key })
    .from(settings)
    .where(like(settings.key, `${SETTING_PREFIX}%`))
    .all();
  for (const row of rows) {
    deleteSetting(row.key);
  }
}
