import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

const originalDir = process.env.JOURNAL_DATA_DIR;
const scratch = mkdtempSync(join(tmpdir(), "journal-rebuild-skip-test-"));
process.env.JOURNAL_DATA_DIR = scratch;
const { db, accounts, executions, trades } = await import("../src/db");
const { rebuildAccount } = await import("../src/server/rebuild");

const fill = (id: string, symbol: string, side: "buy" | "sell", price: number, at: string) => ({
  id,
  accountId: "acc",
  symbol,
  side,
  quantity: 10,
  price,
  fee: 1,
  executedAt: at,
  source: "manual" as const,
  contentHash: `h-${id}`,
  createdAt: "2026-01-01",
});

const writes = () =>
  (
    db.$client.prepare("SELECT key, kind FROM write_log ORDER BY rowid").all() as {
      key: string;
      kind: string;
    }[]
  ).map((row) => `${row.kind}:${row.key}`);

beforeEach(() => {
  db.delete(trades).run();
  db.delete(executions).run();
  db.delete(accounts).run();
  db.insert(accounts)
    .values({ id: "acc", name: "Acc", kind: "manual", createdAt: "2026-01-01" })
    .run();
  db.$client.exec(`
    DROP TABLE IF EXISTS write_log;
    CREATE TABLE write_log (key TEXT, kind TEXT);
    DROP TRIGGER IF EXISTS log_trade_insert;
    DROP TRIGGER IF EXISTS log_trade_update;
    CREATE TRIGGER log_trade_insert AFTER INSERT ON trades
      BEGIN INSERT INTO write_log VALUES (NEW.key, 'insert'); END;
    CREATE TRIGGER log_trade_update AFTER UPDATE ON trades
      BEGIN INSERT INTO write_log VALUES (NEW.key, 'update'); END;
  `);
  db.insert(executions)
    .values([
      fill("a1", "AAA", "buy", 10, "2026-02-01T10:00:00Z"),
      fill("a2", "AAA", "sell", 12, "2026-02-01T11:00:00Z"),
      fill("b1", "BBB", "buy", 20, "2026-02-02T10:00:00Z"),
      fill("b2", "BBB", "sell", 19, "2026-02-02T11:00:00Z"),
    ])
    .run();
});
afterAll(() => {
  db.$client.close();
  if (originalDir === undefined) delete process.env.JOURNAL_DATA_DIR;
  else process.env.JOURNAL_DATA_DIR = originalDir;
  rmSync(scratch, { recursive: true, force: true });
});

describe("rebuildAccount skips rows whose computed values are unchanged", () => {
  it("writes each trade once, then nothing on an identical rebuild", () => {
    rebuildAccount("acc");
    expect(writes()).toHaveLength(2);
    expect(writes().every((entry) => entry.startsWith("insert:"))).toBe(true);
    const before = db.select().from(trades).all();

    db.$client.exec("DELETE FROM write_log");
    rebuildAccount("acc");
    expect(writes()).toEqual([]);
    expect(db.select().from(trades).all()).toEqual(before);
  });

  it("rewrites only the trade whose executions changed and keeps annotations", () => {
    rebuildAccount("acc");
    const [aaa] = db.select().from(trades).where(eq(trades.symbol, "AAA")).all();
    const annotations = {
      notes: "kept",
      tagsJson: '["x"]',
      mistakesJson: '["m"]',
      playbookId: null,
      rating: 4,
      stopLoss: 9,
      profitTarget: 15,
      reviewedAt: "2026-02-03T00:00:00Z",
    };
    db.update(trades).set(annotations).where(eq(trades.key, aaa!.key)).run();
    db.update(executions).set({ price: 13 }).where(eq(executions.id, "a2")).run();

    db.$client.exec("DELETE FROM write_log");
    rebuildAccount("acc");

    expect(writes()).toEqual([`update:${aaa!.key}`]);
    const after = db.select().from(trades).where(eq(trades.key, aaa!.key)).get()!;
    expect(after.grossPnl).toBe(30);
    expect(after).toMatchObject(annotations);
  });

  it("still deletes trades whose executions are gone", () => {
    rebuildAccount("acc");
    db.delete(executions).where(eq(executions.symbol, "BBB")).run();
    rebuildAccount("acc");
    expect(
      db
        .select()
        .from(trades)
        .all()
        .map((row) => row.symbol),
    ).toEqual(["AAA"]);
  });
});
