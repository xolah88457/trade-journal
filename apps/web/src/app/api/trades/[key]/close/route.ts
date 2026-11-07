import { eq } from "drizzle-orm";
import { accounts, db } from "@/db";
import { bad, handler, ok, requireValue, RequestError } from "@/server/api";
import { insertExecutions, listExecutions } from "@/server/executions";
import { getTradeByKey } from "@/server/trades-query";

type Params = { params: Promise<{ key: string }> };

export type CloseOutcome = "stop_loss" | "profit_target" | "break_even" | "custom";
const ALLOWED_OUTCOMES = new Set<string>(["stop_loss", "profit_target", "break_even", "custom"]);

interface CloseTradeBody {
  outcome?: CloseOutcome;
  price?: number;
  fee?: number;
  executedAt?: string;
  notes?: string;
}

const parseExecutionIds = (raw: string | null | undefined): string[] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
};

/** Custom error to carry HTTP status while extending RequestError so handler maps correctly */
class CloseRouteError extends RequestError {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "CloseRouteError";
    this.status = status;
  }
}

/**
 * Close an existing open trade by creating a single opposing fill for the exact open quantity.
 * Rejects closed trades, duplicate closes, and non-manual accounts.
 */
export const POST = handler(async (request: Request, { params }: Params) => {
  // Parse request body FIRST, before transaction and db reads
  const body = ((await request.json().catch(() => ({}))) ?? {}) as CloseTradeBody;
  const { key } = await params;

  try {
    const result = db.transaction(() => {
      const row = getTradeByKey(key);
      if (!row) throw new CloseRouteError("Trade not found", 404);

      if (row.status !== "open" || row.openQuantity <= 0) {
        throw new CloseRouteError("Trade is already closed", 400);
      }

      // Restrict to manual accounts: don't fabricate fills for imported or synced accounts
      const account = db.select().from(accounts).where(eq(accounts.id, row.accountId)).get();
      if (!account || account.kind !== "manual") {
        throw new CloseRouteError("Closing trades is only supported for manual accounts", 400);
      }

      if (body.outcome != null && !ALLOWED_OUTCOMES.has(body.outcome)) {
        throw new CloseRouteError("Invalid outcome specified.", 400);
      }

      const outcome = body.outcome ?? "custom";

      let exitPrice: number | undefined;
      if (outcome === "stop_loss") {
        requireValue(
          row.stopLoss != null && Number.isFinite(row.stopLoss),
          "Trade has no planned stop loss level.",
        );
        exitPrice = row.stopLoss;
      } else if (outcome === "profit_target") {
        requireValue(
          row.profitTarget != null && Number.isFinite(row.profitTarget),
          "Trade has no planned take profit level.",
        );
        exitPrice = row.profitTarget;
      } else if (outcome === "break_even") {
        // Break even before fees closes at exact avgEntry price (gross P&L = 0)
        exitPrice = row.avgEntry;
      } else {
        exitPrice = body.price;
      }

      requireValue(
        exitPrice != null && Number.isFinite(exitPrice) && exitPrice > 0,
        "Valid exit price is required.",
      );

      const fee = body.fee == null ? 0 : Number(body.fee);
      requireValue(Number.isFinite(fee) && fee >= 0, "Fee must be a finite non-negative number.");

      const executedAt = body.executedAt ?? new Date().toISOString();
      requireValue(Number.isFinite(Date.parse(executedAt)), "Exit date & time is invalid.");

      // Require closetime strictly AFTER latest execution for this trade's executionIdsJson
      const execIds = parseExecutionIds(row.executionIdsJson);
      const executionsList = listExecutions(row.accountId, execIds);
      let latestExecTime = Date.parse(row.openedAt);
      for (const exec of executionsList) {
        const t = Date.parse(exec.executedAt);
        if (Number.isFinite(t) && t > latestExecTime) {
          latestExecTime = t;
        }
      }

      const closeTime = Date.parse(executedAt);
      requireValue(
        closeTime > latestExecTime,
        "Exit date & time must be strictly after the latest trade execution.",
      );

      const exitSide: "buy" | "sell" = row.direction === "long" ? "sell" : "buy";

      const exitFill = {
        symbol: row.symbol,
        side: exitSide,
        quantity: row.openQuantity,
        price: exitPrice!,
        fee,
        executedAt,
      };

      const insertRes = insertExecutions(row.accountId, [exitFill], "manual", body.notes);

      return {
        tradeKey: row.key,
        result: insertRes,
      };
    });

    return ok({
      success: true,
      tradeKey: result.tradeKey,
      result: result.result,
    });
  } catch (error) {
    if (error instanceof CloseRouteError) {
      return bad(error.message, error.status);
    }
    throw error;
  }
});
