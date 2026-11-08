import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalDir = process.env.JOURNAL_DATA_DIR;
const scratch = mkdtempSync(join(tmpdir(), "trade-report-test-"));
process.env.JOURNAL_DATA_DIR = scratch;

vi.mock("@/server/ai-review-history", () => ({ listTradeAiReviews: async () => [] }));

const { db, accounts, attachments, executions, settings, trades } = await import("../src/db");
const { rebuildAccount } = await import("../src/server/rebuild");
const { setSetting } = await import("../src/server/settings");
const { getTradeReport } = await import("../src/server/daily-report");
const { GET: getReport } = await import("../src/app/api/trades/[key]/report/route");

const fill = (
  id: string,
  symbol: string,
  side: "buy" | "sell",
  price: number,
  executedAt: string,
) => ({
  id,
  accountId: "acc1",
  symbol,
  side,
  quantity: 2,
  price,
  fee: 1,
  executedAt,
  source: "manual" as const,
  contentHash: `hash-${id}`,
  createdAt: executedAt,
});

beforeEach(() => {
  vi.stubEnv("JOURNAL_PASSWORD", "");
  db.delete(attachments).run();
  db.delete(trades).run();
  db.delete(executions).run();
  db.delete(settings).run();
  db.delete(accounts).run();
  setSetting("timeZone", "UTC");
  db.insert(accounts)
    .values({ id: "acc1", name: "Main", kind: "manual", currency: "USD", createdAt: "2026-01-01" })
    .run();
  db.insert(executions)
    .values([
      fill("c1", "NVDA", "buy", 100, "2026-09-15T10:00:00Z"),
      fill("c2", "NVDA", "sell", 110, "2026-09-15T11:00:00Z"),
      fill("o1", "AMD", "buy", 50, "2026-09-16T10:00:00Z"),
    ])
    .run();
  rebuildAccount("acc1");
});

afterAll(() => {
  vi.unstubAllEnvs();
  db.$client.close();
  if (originalDir === undefined) delete process.env.JOURNAL_DATA_DIR;
  else process.env.JOURNAL_DATA_DIR = originalDir;
  rmSync(scratch, { recursive: true, force: true });
});

const keyOf = (symbol: string) =>
  db
    .select()
    .from(trades)
    .all()
    .find((t) => t.symbol === symbol)!.key;

describe("getTradeReport", () => {
  it("builds the day-report trade shape for a closed trade", async () => {
    const report = await getTradeReport(keyOf("NVDA"));
    expect(report.timeZone).toBe("UTC");
    expect(report.trade).toMatchObject({
      symbol: "NVDA",
      accountName: "Main",
      currency: "USD",
      status: "win",
      direction: "long",
    });
    expect(report.trade.executions.map((e) => e.id)).toEqual(["c1", "c2"]);
    expect(report.trade.runningPnl.length).toBeGreaterThan(1);
    expect(report.trade.netPnl).toBeCloseTo(18, 5); // 2 x 10 gross - 2 fees (1 per fill)
  });

  it("includes open trades, which the day report excludes", async () => {
    const report = await getTradeReport(keyOf("AMD"));
    expect(report.trade.status).toBe("open");
    expect(report.trade.closedAt).toBeNull();
    expect(report.trade.executions).toHaveLength(1);
  });

  it("rejects unknown keys (route answers 404)", async () => {
    await expect(getTradeReport("nope")).rejects.toThrow("Trade not found");
    const res = await getReport(new Request("http://localhost/api/trades/nope/report"), {
      params: Promise.resolve({ key: "nope" }),
    });
    expect(res.status).toBe(404);
    const ok = await getReport(new Request("http://localhost/x"), {
      params: Promise.resolve({ key: keyOf("NVDA") }),
    });
    expect(ok.status).toBe(200);
  });
});
