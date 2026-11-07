import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

const originalDir = process.env.JOURNAL_DATA_DIR;
const scratch = mkdtempSync(join(tmpdir(), "manual-trade-test-"));
process.env.JOURNAL_DATA_DIR = scratch;

const { db, accounts, executions, trades } = await import("../src/db");
const { POST: postExecutions } = await import("../src/app/api/executions/route");
const { POST: postCloseTrade } = await import("../src/app/api/trades/[key]/close/route");
const { GET: getTrade } = await import("../src/app/api/trades/[key]/route");

beforeEach(() => {
  vi.stubEnv("JOURNAL_PASSWORD", "");
  db.delete(trades).run();
  db.delete(executions).run();
  db.delete(accounts).run();
  db.insert(accounts)
    .values({ id: "man1", name: "Manual Account", kind: "manual", createdAt: "2026-01-01" })
    .run();
  db.insert(accounts)
    .values({ id: "sync1", name: "Sync Account", kind: "sync", createdAt: "2026-01-01" })
    .run();
});

afterAll(() => {
  vi.unstubAllEnvs();
  db.$client.close();
  if (originalDir === undefined) delete process.env.JOURNAL_DATA_DIR;
  else process.env.JOURNAL_DATA_DIR = originalDir;
  rmSync(scratch, { recursive: true, force: true });
});

describe("simplified reliable manual trade entry", () => {
  it("saves arbitrary free-text symbol with open position and planned SL/TP", async () => {
    const res = await postExecutions(
      new Request("http://localhost/api/executions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: "man1",
          executions: [
            {
              symbol: "CUSTOM/XYZ-PRED-99",
              side: "buy",
              quantity: 5,
              price: 100,
              fee: 2.5,
              executedAt: "2026-10-01T10:00:00Z",
            },
          ],
          stopLoss: 90,
          profitTarget: 120,
          notes: "Arbitrary ticker open trade test",
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.inserted).toBe(1);
    expect(body.tradeKeys).toHaveLength(1);

    const savedTrade = db.select().from(trades).where(eq(trades.key, body.tradeKeys[0])).get()!;
    expect(savedTrade).toBeDefined();
    expect(savedTrade.symbol).toBe("CUSTOM/XYZ-PRED-99");
    expect(savedTrade.status).toBe("open");
    expect(savedTrade.openQuantity).toBe(5);
    expect(savedTrade.stopLoss).toBe(90);
    expect(savedTrade.profitTarget).toBe(120);
    expect(savedTrade.notes).toBe("Arbitrary ticker open trade test");

    // Check detail API for plannedR calculation
    const detailRes = await getTrade(new Request("http://localhost/api/trades/f"), {
      params: Promise.resolve({ key: savedTrade.key }),
    });
    const detail = await detailRes.json();
    expect(detail.trade.status).toBe("open");
    expect(detail.trade.plannedR).toBe(2); // (120 - 100) / (100 - 90) = 20 / 10 = 2R
  });

  it("creates closed long trade with Take Profit hit (entry + exactly one exit fill), preserving both plans", async () => {
    const res = await postExecutions(
      new Request("http://localhost/api/executions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: "man1",
          executions: [
            {
              symbol: "BTCUSD",
              side: "buy",
              quantity: 1,
              price: 50000,
              fee: 10,
              executedAt: "2026-10-02T10:00:00Z",
            },
            {
              symbol: "BTCUSD",
              side: "sell",
              quantity: 1,
              price: 55000, // TP hit
              fee: 10,
              executedAt: "2026-10-02T12:00:00Z",
            },
          ],
          stopLoss: 48000,
          profitTarget: 55000,
        }),
      }),
    );
    expect(res.status).toBe(200);

    const trade = db.select().from(trades).all()[0]!;
    expect(trade.symbol).toBe("BTCUSD");
    expect(trade.status).toBe("win");
    expect(trade.openQuantity).toBe(0);
    expect(trade.grossPnl).toBe(5000);
    expect(trade.fees).toBe(20);
    expect(trade.netPnl).toBe(4980);
    expect(trade.stopLoss).toBe(48000);
    expect(trade.profitTarget).toBe(55000);

    // Exactly 2 fills exist in DB
    const fills = db.select().from(executions).all();
    expect(fills).toHaveLength(2);
  });

  it("creates closed short trade with Stop Loss hit", async () => {
    const res = await postExecutions(
      new Request("http://localhost/api/executions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: "man1",
          executions: [
            {
              symbol: "ETHUSDT",
              side: "sell", // Short
              quantity: 10,
              price: 3000,
              fee: 5,
              executedAt: "2026-10-03T10:00:00Z",
            },
            {
              symbol: "ETHUSDT",
              side: "buy", // Buy to cover at SL
              quantity: 10,
              price: 3200,
              fee: 5,
              executedAt: "2026-10-03T11:00:00Z",
            },
          ],
          stopLoss: 3200, // SL above entry for short
          profitTarget: 2600, // TP below entry for short
        }),
      }),
    );
    expect(res.status).toBe(200);

    const trade = db.select().from(trades).all()[0]!;
    expect(trade.direction).toBe("short");
    expect(trade.status).toBe("loss");
    expect(trade.grossPnl).toBe(-2000);
    expect(trade.netPnl).toBe(-2010);
    expect(trade.stopLoss).toBe(3200);
    expect(trade.profitTarget).toBe(2600);
  });

  it("break-even closes at entry price (gross 0) while fees are deducted normally", async () => {
    const res = await postExecutions(
      new Request("http://localhost/api/executions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: "man1",
          executions: [
            {
              symbol: "SOLUSD",
              side: "buy",
              quantity: 20,
              price: 150,
              fee: 3,
              executedAt: "2026-10-04T10:00:00Z",
            },
            {
              symbol: "SOLUSD",
              side: "sell",
              quantity: 20,
              price: 150, // Entry price -> gross 0
              fee: 3,
              executedAt: "2026-10-04T10:30:00Z",
            },
          ],
          stopLoss: 140,
          profitTarget: 170,
        }),
      }),
    );
    expect(res.status).toBe(200);

    const trade = db.select().from(trades).all()[0]!;
    expect(trade.grossPnl).toBe(0);
    expect(trade.fees).toBe(6);
    expect(trade.netPnl).toBe(-6); // Net P&L is -fees, not falsified
    expect(trade.stopLoss).toBe(140);
    expect(trade.profitTarget).toBe(170);
  });

  it("validates plan side geometry and rolls back atomically on geometry error", async () => {
    // For a BUY trade: stopLoss must be < avgEntry, profitTarget must be > avgEntry
    const resInvalidSl = await postExecutions(
      new Request("http://localhost/api/executions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: "man1",
          executions: [
            {
              symbol: "AAPL",
              side: "buy",
              quantity: 10,
              price: 200,
              fee: 0,
              executedAt: "2026-10-05T10:00:00Z",
            },
          ],
          stopLoss: 210, // Invalid SL for long (above entry)
        }),
      }),
    );
    expect(resInvalidSl.status).toBe(400);
    expect((await resInvalidSl.json()).error).toContain(
      "Stop loss (210) must be below entry price (200)",
    );

    // Ensure atomic rollback: no executions or trades remained
    expect(db.select().from(executions).all()).toHaveLength(0);
    expect(db.select().from(trades).all()).toHaveLength(0);

    const resInvalidTp = await postExecutions(
      new Request("http://localhost/api/executions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: "man1",
          executions: [
            {
              symbol: "AAPL",
              side: "buy",
              quantity: 10,
              price: 200,
              fee: 0,
              executedAt: "2026-10-05T10:00:00Z",
            },
          ],
          profitTarget: 190, // Invalid TP for long (below entry)
        }),
      }),
    );
    expect(resInvalidTp.status).toBe(400);
    expect((await resInvalidTp.json()).error).toContain(
      "Take profit (190) must be above entry price (200)",
    );
    expect(db.select().from(executions).all()).toHaveLength(0);
  });

  it("supports closing an open planned trade via POST /api/trades/[key]/close", async () => {
    // 1. Create open trade with plans
    const openRes = await postExecutions(
      new Request("http://localhost/api/executions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: "man1",
          executions: [
            {
              symbol: "NVDA",
              side: "buy",
              quantity: 50,
              price: 120,
              fee: 5,
              executedAt: "2026-10-06T09:30:00Z",
            },
          ],
          stopLoss: 110,
          profitTarget: 140,
        }),
      }),
    );
    const openBody = await openRes.json();
    const tradeKey = openBody.tradeKeys[0];

    // 2. Close via outcome: profit_target
    const closeRes = await postCloseTrade(
      new Request("http://localhost/api/trades/nvda/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          outcome: "profit_target",
          fee: 5,
          executedAt: "2026-10-06T15:00:00Z",
        }),
      }),
      { params: Promise.resolve({ key: tradeKey }) },
    );
    expect(closeRes.status).toBe(200);

    const closedTrade = db.select().from(trades).where(eq(trades.key, tradeKey)).get()!;
    expect(closedTrade.status).toBe("win");
    expect(closedTrade.openQuantity).toBe(0);
    expect(closedTrade.avgExit).toBe(140);
    expect(closedTrade.grossPnl).toBe(50 * (140 - 120)); // 1000
    expect(closedTrade.fees).toBe(10);
    expect(closedTrade.netPnl).toBe(990);
    expect(closedTrade.stopLoss).toBe(110);
    expect(closedTrade.profitTarget).toBe(140);

    // 3. Attempting to close again rejects duplicate close
    const dupRes = await postCloseTrade(
      new Request("http://localhost/api/trades/nvda/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outcome: "break_even" }),
      }),
      { params: Promise.resolve({ key: tradeKey }) },
    );
    expect(dupRes.status).toBe(400);
    expect((await dupRes.json()).error).toContain("already closed");
  });

  it("rejects close endpoint on sync / non-manual accounts and invalid exit timestamp", async () => {
    // Insert execution directly or via import to sync account
    db.insert(trades)
      .values({
        key: "sync_trade_key",
        accountId: "sync1",
        symbol: "TSLA",
        direction: "long",
        status: "open",
        openedAt: "2026-10-07T10:00:00Z",
        quantity: 10,
        openQuantity: 10,
        avgEntry: 250,
        grossPnl: 0,
        fees: 0,
        netPnl: 0,
        executionCount: 1,
        executionIdsJson: "[]",
        exitsJson: "[]",
      })
      .run();

    const closeSync = await postCloseTrade(
      new Request("http://localhost/api/trades/key/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outcome: "break_even" }),
      }),
      { params: Promise.resolve({ key: "sync_trade_key" }) },
    );
    expect(closeSync.status).toBe(400);
    expect((await closeSync.json()).error).toContain("only supported for manual accounts");
  });
});
