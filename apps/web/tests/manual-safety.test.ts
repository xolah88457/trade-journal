import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

const originalDir = process.env.JOURNAL_DATA_DIR;
const scratch = mkdtempSync(join(tmpdir(), "manual-safety-test-"));
process.env.JOURNAL_DATA_DIR = scratch;

const { db, accounts, executions, trades } = await import("../src/db");
const { POST: postExecutions } = await import("../src/app/api/executions/route");

beforeEach(() => {
  vi.stubEnv("JOURNAL_PASSWORD", "");
  db.delete(trades).run();
  db.delete(executions).run();
  db.delete(accounts).run();
  db.insert(accounts)
    .values({ id: "man_safe", name: "Manual Account", kind: "manual", createdAt: "2026-01-01" })
    .run();
  db.insert(accounts)
    .values({ id: "sync_safe", name: "Sync Account", kind: "sync", createdAt: "2026-01-01" })
    .run();
});

afterAll(() => {
  vi.unstubAllEnvs();
  db.$client.close();
  if (originalDir === undefined) delete process.env.JOURNAL_DATA_DIR;
  else process.env.JOURNAL_DATA_DIR = originalDir;
  rmSync(scratch, { recursive: true, force: true });
});

describe("manual trade safety flag and tie ordering", () => {
  it("rejects manualTrade flag on sync / non-manual accounts", async () => {
    const res = await postExecutions(
      new Request("http://localhost/api/executions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: "sync_safe",
          manualTrade: true,
          executions: [
            {
              symbol: "AAPL",
              side: "buy",
              quantity: 10,
              price: 150,
              fee: 1,
              executedAt: "2026-10-01T10:00:00Z",
            },
          ],
        }),
      }),
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Manual trade flag requires a manual account");
  });

  it("enforces 1 leg or 2 opposite legs with same quantity when manualTrade is true", async () => {
    // 3 fills should fail
    const res3 = await postExecutions(
      new Request("http://localhost/api/executions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: "man_safe",
          manualTrade: true,
          executions: [
            {
              symbol: "AAPL",
              side: "buy",
              quantity: 10,
              price: 150,
              fee: 1,
              executedAt: "2026-10-01T10:00:00Z",
            },
            {
              symbol: "AAPL",
              side: "sell",
              quantity: 5,
              price: 155,
              fee: 1,
              executedAt: "2026-10-01T11:00:00Z",
            },
            {
              symbol: "AAPL",
              side: "sell",
              quantity: 5,
              price: 160,
              fee: 1,
              executedAt: "2026-10-01T12:00:00Z",
            },
          ],
        }),
      }),
    );
    expect(res3.status).toBe(400);
    expect((await res3.json()).error).toContain("1 entry leg or 2 legs");

    // 2 legs with same side should fail
    const resSameSide = await postExecutions(
      new Request("http://localhost/api/executions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: "man_safe",
          manualTrade: true,
          executions: [
            {
              symbol: "AAPL",
              side: "buy",
              quantity: 10,
              price: 150,
              fee: 1,
              executedAt: "2026-10-01T10:00:00Z",
            },
            {
              symbol: "AAPL",
              side: "buy",
              quantity: 10,
              price: 155,
              fee: 1,
              executedAt: "2026-10-01T11:00:00Z",
            },
          ],
        }),
      }),
    );
    expect(resSameSide.status).toBe(400);
    expect((await resSameSide.json()).error).toContain("opposite sides");

    // 2 legs with unequal quantity should fail
    const resDiffQty = await postExecutions(
      new Request("http://localhost/api/executions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: "man_safe",
          manualTrade: true,
          executions: [
            {
              symbol: "AAPL",
              side: "buy",
              quantity: 10,
              price: 150,
              fee: 1,
              executedAt: "2026-10-01T10:00:00Z",
            },
            {
              symbol: "AAPL",
              side: "sell",
              quantity: 5,
              price: 155,
              fee: 1,
              executedAt: "2026-10-01T11:00:00Z",
            },
          ],
        }),
      }),
    );
    expect(resDiffQty.status).toBe(400);
    expect((await resDiffQty.json()).error).toContain("identical quantity");
  });

  it("orders same-time buy and sell via trusted order: buy is entry, sell is exit, trade is closed long", async () => {
    const timestamp = "2026-10-05T14:30:00.000Z";
    const res = await postExecutions(
      new Request("http://localhost/api/executions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: "man_safe",
          manualTrade: true,
          executions: [
            {
              symbol: "TSLA",
              side: "buy",
              quantity: 5,
              price: 200,
              fee: 1,
              executedAt: timestamp,
            },
            {
              symbol: "TSLA",
              side: "sell",
              quantity: 5,
              price: 210,
              fee: 1,
              executedAt: timestamp,
            },
          ],
          stopLoss: 195,
          profitTarget: 210,
          notes: "Same instant long trade",
        }),
      }),
    );
    expect(res.status).toBe(200);

    const tradeList = db.select().from(trades).where(eq(trades.accountId, "man_safe")).all();
    expect(tradeList).toHaveLength(1);
    const trade = tradeList[0]!;
    expect(trade.direction).toBe("long");
    expect(trade.status).toBe("win");
    expect(trade.avgEntry).toBe(200);
    expect(trade.avgExit).toBe(210);
    expect(trade.grossPnl).toBe(50);
    expect(trade.stopLoss).toBe(195);
    expect(trade.profitTarget).toBe(210);
    expect(trade.notes).toBe("Same instant long trade");
  });

  it("atomic rollback and no annotation overwrite if new manual trade merges with previous open position", async () => {
    // 1. Create an existing open position with notes and plans
    const firstRes = await postExecutions(
      new Request("http://localhost/api/executions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: "man_safe",
          manualTrade: true,
          executions: [
            {
              symbol: "NVDA",
              side: "buy",
              quantity: 10,
              price: 100,
              fee: 2,
              executedAt: "2026-10-06T10:00:00Z",
            },
          ],
          stopLoss: 90,
          profitTarget: 130,
          notes: "Initial open NVDA position",
        }),
      }),
    );
    expect(firstRes.status).toBe(200);

    const initialTrades = db.select().from(trades).where(eq(trades.accountId, "man_safe")).all();
    expect(initialTrades).toHaveLength(1);
    const initialTrade = initialTrades[0]!;
    const initialKey = initialTrade.key;

    // 2. Try to add a second manual buy trade on the same symbol without closing the first
    // In normal FIFO/netting this would merge into the open trade, but manualTrade:true must reject
    const mergeAttempt = await postExecutions(
      new Request("http://localhost/api/executions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: "man_safe",
          manualTrade: true,
          executions: [
            {
              symbol: "NVDA",
              side: "buy",
              quantity: 5,
              price: 105,
              fee: 1,
              executedAt: "2026-10-06T11:00:00Z",
            },
          ],
          stopLoss: 95,
          profitTarget: 140,
          notes: "Should not merge or overwrite notes",
        }),
      }),
    );
    expect(mergeAttempt.status).toBe(400);
    const errBody = await mergeAttempt.json();
    expect(errBody.error).toContain("New manual trade cannot merge with an existing open position");

    // 3. Verify original trade annotations and executions remain intact (no overwrite)
    const afterTrades = db.select().from(trades).where(eq(trades.accountId, "man_safe")).all();
    expect(afterTrades).toHaveLength(1);
    const tradeAfter = afterTrades[0]!;
    expect(tradeAfter.key).toBe(initialKey);
    expect(tradeAfter.quantity).toBe(10);
    expect(tradeAfter.stopLoss).toBe(90);
    expect(tradeAfter.profitTarget).toBe(130);
    expect(tradeAfter.notes).toBe("Initial open NVDA position");

    const execs = db.select().from(executions).where(eq(executions.accountId, "man_safe")).all();
    expect(execs).toHaveLength(1);
  });

  it("handles duplicate execution insertion (inserted: 0) clearly with no overwrites", async () => {
    const payload = {
      accountId: "man_safe",
      manualTrade: true,
      executions: [
        {
          symbol: "AMD",
          side: "buy" as const,
          quantity: 20,
          price: 80,
          fee: 0,
          executedAt: "2026-10-07T10:00:00Z",
        },
      ],
      stopLoss: 75,
      notes: "Original AMD note",
    };

    const first = await postExecutions(
      new Request("http://localhost/api/executions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
    );
    expect(first.status).toBe(200);

    // Submitting duplicate with changed notes/plans
    const duplicate = await postExecutions(
      new Request("http://localhost/api/executions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...payload,
          notes: "Attempted duplicate overwrite note",
          stopLoss: 70,
        }),
      }),
    );
    expect(duplicate.status).toBe(400);
    const dupBody = await duplicate.json();
    expect(dupBody.error).toContain("already exists in journal");

    // Confirm notes were not overwritten
    const trade = db.select().from(trades).where(eq(trades.accountId, "man_safe")).get()!;
    expect(trade.notes).toBe("Original AMD note");
    expect(trade.stopLoss).toBe(75);
  });
});
