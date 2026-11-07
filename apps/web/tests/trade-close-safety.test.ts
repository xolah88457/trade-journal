import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

const originalDir = process.env.JOURNAL_DATA_DIR;
const scratch = mkdtempSync(join(tmpdir(), "trade-close-safety-test-"));
process.env.JOURNAL_DATA_DIR = scratch;

const { db, accounts, executions, trades } = await import("../src/db");
const { POST: postExecutions } = await import("../src/app/api/executions/route");
const { POST: postCloseTrade } = await import("../src/app/api/trades/[key]/close/route");

beforeEach(() => {
  vi.stubEnv("JOURNAL_PASSWORD", "");
  db.delete(trades).run();
  db.delete(executions).run();
  db.delete(accounts).run();
  db.insert(accounts)
    .values({ id: "man1", name: "Manual Account", kind: "manual", createdAt: "2026-01-01" })
    .run();
});

afterAll(() => {
  vi.unstubAllEnvs();
  db.$client.close();
  if (originalDir === undefined) delete process.env.JOURNAL_DATA_DIR;
  else process.env.JOURNAL_DATA_DIR = originalDir;
  rmSync(scratch, { recursive: true, force: true });
});

describe("trade close safety and race condition protection", () => {
  it("two simultaneous close POST promises with different exit dates: exactly one succeeds and no position reversal", async () => {
    // 1. Open a position: Buy 100 AAPL @ 150
    const openRes = await postExecutions(
      new Request("http://localhost/api/executions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: "man1",
          executions: [
            {
              symbol: "AAPL",
              side: "buy",
              quantity: 100,
              price: 150,
              fee: 1,
              executedAt: "2026-10-01T10:00:00Z",
            },
          ],
        }),
      }),
    );
    expect(openRes.status).toBe(200);
    const openData = await openRes.json();
    const tradeKey = openData.tradeKeys[0];
    expect(tradeKey).toBeTruthy();

    const openTrade = db.select().from(trades).where(eq(trades.key, tradeKey)).get()!;
    expect(openTrade.status).toBe("open");
    expect(openTrade.openQuantity).toBe(100);

    // 2. Launch two simultaneous close requests with different exit dates
    const closePromise1 = postCloseTrade(
      new Request("http://localhost/api/trades/aapl/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          outcome: "custom",
          price: 160,
          fee: 1,
          executedAt: "2026-10-01T11:00:00Z",
        }),
      }),
      { params: Promise.resolve({ key: tradeKey }) },
    );

    const closePromise2 = postCloseTrade(
      new Request("http://localhost/api/trades/aapl/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          outcome: "custom",
          price: 165,
          fee: 1,
          executedAt: "2026-10-01T12:00:00Z",
        }),
      }),
      { params: Promise.resolve({ key: tradeKey }) },
    );

    const [res1, res2] = await Promise.all([closePromise1, closePromise2]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([200, 400]);

    // Check error message on the failed one
    const failedRes = res1.status === 400 ? res1 : res2;
    const failedJson = await failedRes.json();
    expect(failedJson.error).toContain("already closed");

    // Check trade state: exactly closed, openQuantity 0, exactly one exit fill created
    const allExecs = db.select().from(executions).where(eq(executions.accountId, "man1")).all();
    // 1 entry execution + 1 exit execution = 2 executions total (no reverse position / no duplicate exit)
    expect(allExecs.length).toBe(2);
    const exitExecs = allExecs.filter((e) => e.side === "sell");
    expect(exitExecs.length).toBe(1);
    expect(exitExecs[0]?.quantity).toBe(100);

    const allTrades = db.select().from(trades).where(eq(trades.accountId, "man1")).all();
    expect(allTrades.length).toBe(1);
    expect(allTrades[0]?.openQuantity).toBe(0);
    expect(allTrades[0]?.status).not.toBe("open");
  });

  it("scale-in late and backdated close rejects atomically", async () => {
    // 1. Initial entry at 10:00:00
    const openRes = await postExecutions(
      new Request("http://localhost/api/executions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: "man1",
          executions: [
            {
              symbol: "MSFT",
              side: "buy",
              quantity: 10,
              price: 300,
              fee: 0,
              executedAt: "2026-10-01T10:00:00Z",
            },
          ],
        }),
      }),
    );
    expect(openRes.status).toBe(200);
    const tradeKey = (await openRes.json()).tradeKeys[0];

    // 2. Scale-in late at 12:00:00 (trade.openedAt is 10:00:00, but latest execution is 12:00:00)
    const scaleRes = await postExecutions(
      new Request("http://localhost/api/executions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: "man1",
          executions: [
            {
              symbol: "MSFT",
              side: "buy",
              quantity: 10,
              price: 310,
              fee: 0,
              executedAt: "2026-10-01T12:00:00Z",
            },
          ],
        }),
      }),
    );
    expect(scaleRes.status).toBe(200);

    const tradeBefore = db.select().from(trades).where(eq(trades.key, tradeKey)).get()!;
    expect(tradeBefore.openedAt).toBe("2026-10-01T10:00:00Z");
    expect(tradeBefore.openQuantity).toBe(20);

    // 3. Attempt to close at 11:00:00 (after openedAt 10:00:00, but BEFORE latest execution 12:00:00)
    const closeRes = await postCloseTrade(
      new Request("http://localhost/api/trades/msft/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          outcome: "custom",
          price: 320,
          fee: 0,
          executedAt: "2026-10-01T11:00:00Z",
        }),
      }),
      { params: Promise.resolve({ key: tradeKey }) },
    );

    expect(closeRes.status).toBe(400);
    const errJson = await closeRes.json();
    expect(errJson.error).toContain("strictly after the latest trade execution");

    // 4. Verify atomic rollback: trade is still open, openQuantity is still 20, no exit execution was inserted
    const tradeAfter = db.select().from(trades).where(eq(trades.key, tradeKey)).get()!;
    expect(tradeAfter.status).toBe("open");
    expect(tradeAfter.openQuantity).toBe(20);

    const allExecs = db.select().from(executions).where(eq(executions.accountId, "man1")).all();
    expect(allExecs.length).toBe(2);
    expect(allExecs.every((e) => e.side === "buy")).toBe(true);

    // 5. Attempt close with invalid outcome enum
    const badOutcomeRes = await postCloseTrade(
      new Request("http://localhost/api/trades/msft/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          outcome: "invalid_random_enum" as any,
          price: 320,
          fee: 0,
          executedAt: "2026-10-01T13:00:00Z",
        }),
      }),
      { params: Promise.resolve({ key: tradeKey }) },
    );
    expect(badOutcomeRes.status).toBe(400);
    expect((await badOutcomeRes.json()).error).toContain("Invalid outcome specified");

    // 6. Valid close strictly after latest execution (13:00:00) succeeds
    const validCloseRes = await postCloseTrade(
      new Request("http://localhost/api/trades/msft/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          outcome: "custom",
          price: 320,
          fee: 0,
          executedAt: "2026-10-01T13:00:00Z",
        }),
      }),
      { params: Promise.resolve({ key: tradeKey }) },
    );
    expect(validCloseRes.status).toBe(200);
    const tradeFinal = db.select().from(trades).where(eq(trades.key, tradeKey)).get()!;
    expect(tradeFinal.status).not.toBe("open");
    expect(tradeFinal.openQuantity).toBe(0);
  });
});
