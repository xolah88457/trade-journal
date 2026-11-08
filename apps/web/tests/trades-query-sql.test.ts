import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, asc, eq, inArray } from "drizzle-orm";
import { matchesFilters, dayKeyOf, type AnalysisFilters } from "@luxalgo/journal-core";

const originalDir = process.env.JOURNAL_DATA_DIR;
const scratch = mkdtempSync(join(tmpdir(), "journal-trades-query-sql-"));
process.env.JOURNAL_DATA_DIR = scratch;
const { db, accounts, trades, settings } = await import("../src/db");
const { setSetting, getTimeZone, getMultipliers, getJournalDefaults } =
  await import("../src/server/settings");
const { queryTrades, rowToTrade, getAdjacentTradeKeys, parseJsonArray } =
  await import("../src/server/trades-query");
const { GET: lookup } = await import("../src/app/api/trades/lookup/route");

type Filters = AnalysisFilters & { accountIds?: string[] };

/** Verbatim copy of the previous implementation: identity filters in SQL, everything else in JS. */
const legacyQueryTrades = (filters: Filters = {}) => {
  const effective = { ...filters, accounts: filters.accounts ?? filters.accountIds?.join(",") };
  const accountIds = effective.accounts
    ?.split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const all = db
    .select()
    .from(trades)
    .where(
      and(
        accountIds?.length ? inArray(trades.accountId, accountIds) : undefined,
        effective.playbookId ? eq(trades.playbookId, effective.playbookId) : undefined,
        effective.direction
          ? eq(trades.direction, effective.direction as "long" | "short")
          : undefined,
        effective.assetClass ? eq(trades.assetClass, effective.assetClass) : undefined,
      ),
    )
    .orderBy(asc(trades.openedAt))
    .all();
  const timeZone = getTimeZone();
  const config = { multipliers: getMultipliers(), defaults: getJournalDefaults() };
  const pairs = all
    .map((row) => ({ row, trade: rowToTrade(row, config) }))
    .filter(({ trade }) => matchesFilters(trade, effective, timeZone));
  return {
    rows: pairs.map(({ row, trade }) => ({ ...row, status: trade.status })),
    trades: pairs.map((p) => p.trade),
  };
};

const legacyAdjacent = (currentKey: string, filters: Filters = {}, accountId?: string) => {
  const ordered = legacyQueryTrades(filters)
    .trades.filter((trade) => !accountId || trade.accountId === accountId)
    .sort((a, b) => {
      const time = Date.parse(a.openedAt) - Date.parse(b.openedAt);
      return time || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    });
  const index = ordered.findIndex((trade) => trade.key === currentKey);
  return {
    prevKey: index > 0 ? (ordered[index - 1]?.key ?? null) : null,
    nextKey: index >= 0 ? (ordered[index + 1]?.key ?? null) : null,
    position: index >= 0 ? index + 1 : null,
    total: ordered.length,
  };
};

let seed = 20261108;
const random = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;

const SYMBOLS = ["ES", "NQ", "AAPL", "aapl", "EURUSD", "Ünï", "ıx", "BTC-USD"];
const ACCOUNTS = ["acc-a", "acc-b", "acc-c"];
const START = Date.parse("2026-03-01T00:00:00Z");
const DAYS = 275; // through the 2026 US and New Zealand DST changes
const HOURS = [3, 4, 5, 6, 10, 11, 12, 13, 22, 23, 0, 1, 14, 20];

beforeAll(() => {
  db.delete(trades).run();
  db.delete(accounts).run();
  db.delete(settings).run();
  db.insert(accounts)
    .values(
      ACCOUNTS.map((id) => ({
        id,
        name: id === "acc-c" ? "Café" : id,
        kind: "manual" as const,
        createdAt: "2026-01-01",
      })),
    )
    .run();
  const rows: (typeof trades.$inferInsert)[] = [];
  const used = new Set<number>();
  for (let index = 0; index < 1500; index++) {
    let opened: number;
    do {
      opened =
        START +
        Math.floor(random() * DAYS) * 86_400_000 +
        pick(HOURS) * 3_600_000 +
        Math.floor(random() * 3_600_000);
    } while (used.has(opened));
    used.add(opened);
    const open = random() < 0.1;
    const net = pick([0, 0.2, -0.2, 50, -75, 1200, -300]);
    const duration = open ? null : Math.floor(random() * 3 * 86_400_000);
    const symbol = pick(SYMBOLS);
    rows.push({
      key: `t${String(index).padStart(5, "0")}`,
      accountId: pick(ACCOUNTS),
      symbol,
      assetClass: pick(["futures", "stock", "crypto", null]),
      direction: pick(["long", "short"] as const),
      status: open ? "open" : net > 0.5 ? "win" : net < -0.5 ? "loss" : "breakeven",
      openedAt: new Date(opened).toISOString(),
      closedAt: open ? null : new Date(opened + duration!).toISOString(),
      quantity: 1 + Math.floor(random() * 5),
      openQuantity: open ? 1 : 0,
      avgEntry: 100 + random() * 10,
      avgExit: open ? null : 100 + random() * 10,
      grossPnl: net,
      fees: 0,
      netPnl: open ? 0 : net,
      executionCount: 2,
      executionIdsJson: "[]",
      exitsJson: "[]",
      durationMs: duration,
      tagsJson: pick([null, "[]", '["a"]', '["a","b"]', '["b"]']),
      mistakesJson: pick([null, '["fomo"]']),
      playbookId: pick([null, "pb1", "pb2"]),
      rating: pick([null, 1, 3, 5]),
      stopLoss: pick([null, 99]),
      reviewedAt: pick([null, "2026-05-01T00:00:00Z"]),
    });
  }
  // Same entry time as another row with a different close, plus an unusual timestamp format.
  rows.push({ ...rows[0]!, key: "zz-format", openedAt: "2026-06-15T03:59:59Z" });
  for (let at = 0; at < rows.length; at += 200)
    db.insert(trades)
      .values(rows.slice(at, at + 200))
      .run();
});

afterAll(() => {
  db.$client.close();
  vi.unstubAllEnvs();
  if (originalDir === undefined) delete process.env.JOURNAL_DATA_DIR;
  else process.env.JOURNAL_DATA_DIR = originalDir;
  rmSync(scratch, { recursive: true, force: true });
});

const zones = ["UTC", "America/New_York", "Pacific/Auckland", "Pacific/Kiritimati"];

const boundaryDays = (zone: string) => {
  const days = new Set<string>();
  for (const day of ["2026-03-08", "2026-03-09", "2026-04-05", "2026-09-27", "2026-11-01"]) {
    for (const shift of [-1, 0, 1])
      days.add(
        dayKeyOf(new Date(Date.parse(`${day}T12:00:00Z`) + shift * 86_400_000).toISOString(), zone),
      );
  }
  return [...days];
};

it("matches the previous implementation for many filter combinations in several zones", () => {
  let combos = 0;
  for (const zone of zones) {
    setSetting("timeZone", zone);
    const days = boundaryDays(zone);
    const filterSets: Filters[] = [{}];
    for (const day of days) {
      filterSets.push({ from: day, to: day }, { from: day }, { to: day });
    }
    filterSets.push(
      { from: "2026-04-01", to: "2026-04-30", accounts: "acc-a, acc-c" },
      { from: "2026-11-01", to: "2026-11-01", status: "open" },
      { from: "2026-09-27", to: "2026-09-28", status: "closed", direction: "long" },
      { from: "2026-03-08", to: "2026-03-08", status: "win", symbol: "aapl,es" },
      { status: "loss", symbol: "Ünï" },
      { status: "breakeven", reviewed: "no", tag: "a" },
      { status: "nonsense" },
      { symbol: "ıx" },
      { symbol: "IX" },
      { symbol: "btc-usd, nq" },
      { symbol: " , " },
      { excludeSymbol: "es", symbol: "es,nq" },
      { reviewed: "yes", playbookId: "pb1" },
      { reviewed: "maybe" },
      { tag: "a,b", mistake: "fomo", from: "2026-05-01" },
      { from: "2026-5-1" },
      { from: "2026-02-30", to: "garbage" },
      { from: "2027-01-01" },
      { to: "2025-01-01" },
      { from: "2026-06-10", to: "2026-06-01" },
      { accounts: "acc-b", from: "2026-10-01", assetClass: "futures", entryAfter: "22:00" },
      { weekdays: "1,2", from: "2026-07-01", to: "2026-08-31", pnlMin: "0" },
      { exitAfter: "23:00", exitBefore: "01:00", from: "2026-03-01", to: "2026-03-31" },
      { accountIds: ["acc-a"], status: "open" } as Filters,
    );
    for (const filters of filterSets) {
      const expected = legacyQueryTrades(filters);
      const actual = queryTrades(filters);
      expect(
        actual.trades.map((t) => t.key),
        JSON.stringify({ zone, filters }),
      ).toEqual(expected.trades.map((t) => t.key));
      expect(JSON.stringify(actual.rows) === JSON.stringify(expected.rows)).toBe(true);
      expect(JSON.stringify(actual.trades) === JSON.stringify(expected.trades)).toBe(true);
      combos++;
    }
  }
  expect(combos).toBeGreaterThan(200);
}, 120_000);

it("returns identical neighbours, positions and totals", () => {
  setSetting("timeZone", "America/New_York");
  const keys = queryTrades().trades.map((t) => t.key);
  const samples = [keys[0]!, keys[1]!, keys[700]!, keys[keys.length - 1]!, "zz-format", "missing"];
  for (const key of samples) {
    for (const filters of [
      {},
      { status: "open" },
      { from: "2026-06-01", to: "2026-06-30" },
    ] as Filters[])
      for (const account of [undefined, "acc-b"]) {
        expect(getAdjacentTradeKeys(key, filters, account)).toEqual(
          legacyAdjacent(key, filters, account),
        );
      }
  }
});

const legacyLookup = (search: string) => {
  const matches: unknown[] = [];
  const rows = db.$client
    .prepare(
      `SELECT t.key, t.symbol, t.direction, t.opened_at AS openedAt,
        COALESCE(a.name, 'Unknown account') AS accountName
       FROM trades t LEFT JOIN accounts a ON a.id = t.account_id
       ORDER BY t.opened_at DESC`,
    )
    .all() as Array<{ symbol: string; openedAt: string; accountName: string }>;
  for (const trade of rows) {
    if (!`${trade.symbol} ${trade.openedAt} ${trade.accountName}`.toLowerCase().includes(search))
      continue;
    matches.push(trade);
  }
  return { trades: matches.slice(0, 50), hasMore: matches.length > 50 };
};

it("trade lookup returns the same page as a full scan", async () => {
  for (const q of [
    "",
    "aapl",
    "AAPL",
    "2026-06-1",
    "acc-a",
    "café",
    "CAFÉ",
    "ünï",
    "İ",
    "ıx",
    "btc",
    "zzz",
    "t",
  ]) {
    const response = await lookup(
      new Request(`http://localhost/api/trades/lookup?q=${encodeURIComponent(q)}`),
    );
    const body = await response.json();
    expect(body, q).toEqual(JSON.parse(JSON.stringify(legacyLookup(q.trim().toLowerCase()))));
  }
});

it("parses JSON arrays defensively", () => {
  expect(parseJsonArray(null)).toEqual([]);
  expect(parseJsonArray("nope")).toEqual([]);
  expect(parseJsonArray('{"a":1}')).toEqual([]);
  expect(parseJsonArray('["a"]')).toEqual(["a"]);
});
