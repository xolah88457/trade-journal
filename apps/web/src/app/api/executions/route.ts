import type { ImportedExecution } from "@luxalgo/journal-importers";
import { eq } from "drizzle-orm";
import { db, accounts } from "@/db";
import { bad, handler, ok, requireValue } from "@/server/api";
import { insertExecutions } from "@/server/executions";

interface ManualBody {
  accountId: string;
  executions: ImportedExecution[];
  notes?: string;
  stopLoss?: number | null;
  profitTarget?: number | null;
  manualTrade?: boolean;
}

/** Manual trade entry: the client sends raw fills (entry legs + exit legs). */
export const POST = handler(async (request: Request) => {
  const body = (await request.json()) as ManualBody;
  requireValue(
    body?.notes === undefined || (typeof body.notes === "string" && body.notes.length <= 100000),
    "Notes must be at most 100,000 characters.",
  );
  if (!body.accountId || !Array.isArray(body.executions) || body.executions.length === 0) {
    return bad("accountId and a non-empty executions array are required");
  }
  for (const row of body.executions) {
    if (
      !row ||
      typeof row.symbol !== "string" ||
      !row.symbol.trim() ||
      !["buy", "sell"].includes(row.side) ||
      typeof row.executedAt !== "string" ||
      !Number.isFinite(Date.parse(row.executedAt)) ||
      !Number.isFinite(row.quantity) ||
      !(row.quantity > 0) ||
      !Number.isFinite(row.price) ||
      !Number.isFinite(row.fee ?? 0)
    ) {
      return bad("every execution needs symbol, side, quantity > 0, price, executedAt");
    }
  }
  for (const field of ["stopLoss", "profitTarget"] as const) {
    if (body[field] !== undefined && body[field] !== null) {
      if (typeof body[field] !== "number" || !Number.isFinite(body[field]) || body[field]! <= 0) {
        return bad(`Invalid ${field}: must be a positive number.`);
      }
    }
  }
  if (body.manualTrade) {
    const account = db
      .select({ id: accounts.id, kind: accounts.kind })
      .from(accounts)
      .where(eq(accounts.id, body.accountId))
      .get();
    if (!account) {
      return bad("Account not found.");
    }
    if (account.kind !== "manual") {
      return bad("Manual trade flag requires a manual account.");
    }
    if (body.executions.length < 1 || body.executions.length > 2) {
      return bad("Manual trade requires either 1 entry leg or 2 legs (entry + exit).");
    }
    if (body.executions.length === 2) {
      const entry = body.executions[0];
      const exit = body.executions[1];
      if (!entry || !exit) {
        return bad("Manual trade requires valid execution legs.");
      }
      if (entry.symbol.trim().toUpperCase() !== exit.symbol.trim().toUpperCase()) {
        return bad("Entry and exit legs must share the same symbol.");
      }
      if (entry.side === exit.side) {
        return bad("Entry and exit legs must be on opposite sides.");
      }
      if (entry.quantity !== exit.quantity) {
        return bad("Entry and exit legs must have identical quantity.");
      }
    }
  }

  const rows = body.executions.map((row) => {
    const { importMetadata: _meta, ...rest } = row;
    return {
      ...(body.manualTrade ? rest : row),
      symbol: row.symbol.trim().toUpperCase(),
      fee: row.fee ?? 0,
    };
  });
  return ok(
    insertExecutions(body.accountId, rows, "manual", body.notes, {
      stopLoss: body.stopLoss,
      profitTarget: body.profitTarget,
      manualTrade: body.manualTrade,
    }),
  );
});
