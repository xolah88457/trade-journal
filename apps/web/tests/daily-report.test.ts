import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";

const originalDir = process.env.JOURNAL_DATA_DIR;
const scratch = mkdtempSync(join(tmpdir(), "daily-report-test-"));
process.env.JOURNAL_DATA_DIR = scratch;

const mockAiReviews = vi.fn(async (tradeKey: string) => {
  if (tradeKey.includes("MSFT")) {
    return [
      {
        id: "rev-1",
        createdAt: "2026-09-15T17:00:00Z",
        content: "AI review critique: cut losses promptly.",
        provider: "openai",
        model: "gpt-4o",
      },
    ];
  }
  return [];
});

vi.mock("@/server/ai-review-history", () => ({
  listTradeAiReviews: (tradeKey: string) => mockAiReviews(tradeKey),
}));

const {
  db,
  accounts,
  attachments,
  executions,
  journalDays,
  playbooks,
  settings,
  tradeExcursions,
  tradeRuleChecks,
  trades,
} = await import("../src/db");

const { rebuildAccount } = await import("../src/server/rebuild");
const { estimateFingerprint } = await import("../src/server/market-data/estimates");
const { rowToTrade } = await import("../src/server/trades-query");
const { setSetting } = await import("../src/server/settings");
const { GET: getExport } = await import("../src/app/api/journal/[date]/export/route");

beforeEach(() => {
  vi.stubEnv("JOURNAL_PASSWORD", "");
  mockAiReviews.mockClear();

  db.delete(tradeExcursions).run();
  db.delete(tradeRuleChecks).run();
  db.delete(attachments).run();
  db.delete(journalDays).run();
  db.delete(trades).run();
  db.delete(executions).run();
  db.delete(playbooks).run();
  db.delete(settings).run();
  db.delete(accounts).run();

  setSetting("timeZone", "UTC");
  setSetting("multipliers", "{}");
  setSetting(
    "journalDefaults",
    JSON.stringify({ breakeven: 0, breakevenMode: "fixed", defaultRisk: 100 }),
  );
});

afterAll(() => {
  vi.unstubAllEnvs();
  db.$client.close();
  if (originalDir === undefined) delete process.env.JOURNAL_DATA_DIR;
  else process.env.JOURNAL_DATA_DIR = originalDir;
  rmSync(scratch, { recursive: true, force: true });
});

describe("readonly complete daily export data", () => {
  it("exports complete day statistics, markdown notes, 2 long losses with fills, plans, ratings, playbook rules, attachments metadata, cached excursions and AI reviews", async () => {
    // 1. Setup accounts
    db.insert(accounts)
      .values({
        id: "acc1",
        name: "Main Trading Account",
        kind: "manual",
        currency: "USD",
        credentialsEnc: "AES256_SECRET_DO_NOT_LEAK",
        createdAt: "2026-01-01T00:00:00Z",
      })
      .run();

    // 2. Setup playbook
    db.insert(playbooks)
      .values({
        id: "pb1",
        name: "Breakout Strategy",
        description: "Standard high timeframe breakout with defined stops",
        rulesJson: JSON.stringify(["Trend aligned", "Risk <= 1%"]),
        createdAt: "2026-01-01T00:00:00Z",
      })
      .run();

    // 3. Trade 1: Long loss with 2 fills (entry + exit)
    db.insert(executions)
      .values([
        {
          id: "fill-1",
          accountId: "acc1",
          symbol: "AAPL",
          side: "buy",
          quantity: 10,
          price: 100,
          fee: 1,
          executedAt: "2026-09-15T14:00:00Z",
          source: "manual",
          contentHash: "hash-1",
          createdAt: "2026-09-15T14:00:00Z",
        },
        {
          id: "fill-2",
          accountId: "acc1",
          symbol: "AAPL",
          side: "sell",
          quantity: 10,
          price: 90,
          fee: 1,
          executedAt: "2026-09-15T15:00:00Z",
          source: "manual",
          contentHash: "hash-2",
          createdAt: "2026-09-15T15:00:00Z",
        },
      ])
      .run();

    rebuildAccount("acc1");

    const trade1Row = db
      .select()
      .from(trades)
      .where(and(eq(trades.accountId, "acc1"), eq(trades.symbol, "AAPL")))
      .get()!;
    expect(trade1Row).toBeDefined();

    // Annotations for Trade 1
    db.update(trades)
      .set({
        stopLoss: 95,
        profitTarget: 110,
        rating: 3,
        reviewedAt: "2026-09-15T16:00:00Z",
        notes: "Markdown note with **bold text** and `code`",
        tagsJson: JSON.stringify(["reversal", "fomc"]),
        mistakesJson: JSON.stringify(["chasing"]),
        playbookId: "pb1",
      })
      .where(eq(trades.key, trade1Row.key))
      .run();

    // Rule checks for Trade 1
    db.insert(tradeRuleChecks)
      .values([
        {
          id: "check-1",
          tradeKey: trade1Row.key,
          playbookId: "pb1",
          rule: "Trend aligned",
          followed: true,
        },
        {
          id: "check-2",
          tradeKey: trade1Row.key,
          playbookId: "pb1",
          rule: "Risk <= 1%",
          followed: false,
        },
      ])
      .run();

    // Attachments for Trade 1: PNG image and PDF document
    db.insert(attachments)
      .values([
        {
          id: "att-img-1",
          ownerType: "trade",
          ownerId: trade1Row.key,
          name: "chart-setup.png",
          mime: "image/png",
          size: 2048,
          data: Buffer.from("fake-png-binary"),
          createdAt: "2026-09-15T15:05:00Z",
        },
        {
          id: "att-pdf-1",
          ownerType: "trade",
          ownerId: trade1Row.key,
          name: "trade-analysis.pdf",
          mime: "application/pdf",
          size: 4096,
          data: Buffer.from("fake-pdf-binary"),
          createdAt: "2026-09-15T15:10:00Z",
        },
      ])
      .run();

    // 4. Trade 2: Another Long loss with 2 fills (entry + exit), hitting stop loss
    db.insert(executions)
      .values([
        {
          id: "fill-3",
          accountId: "acc1",
          symbol: "MSFT",
          side: "buy",
          quantity: 5,
          price: 200,
          fee: 2,
          executedAt: "2026-09-15T14:30:00Z",
          source: "manual",
          contentHash: "hash-3",
          createdAt: "2026-09-15T14:30:00Z",
        },
        {
          id: "fill-4",
          accountId: "acc1",
          symbol: "MSFT",
          side: "sell",
          quantity: 5,
          price: 180,
          fee: 2,
          executedAt: "2026-09-15T15:30:00Z",
          source: "manual",
          contentHash: "hash-4",
          createdAt: "2026-09-15T15:30:00Z",
        },
      ])
      .run();

    rebuildAccount("acc1");

    const trade2Row = db
      .select()
      .from(trades)
      .where(and(eq(trades.accountId, "acc1"), eq(trades.symbol, "MSFT")))
      .get()!;
    expect(trade2Row).toBeDefined();

    db.update(trades)
      .set({
        stopLoss: 180, // avgExit is 180, exactly hits planned SL
        profitTarget: 220,
        rating: 2,
        notes: "Second trade exited at stop loss level",
        tagsJson: JSON.stringify(["breakout"]),
        mistakesJson: JSON.stringify([]),
      })
      .where(eq(trades.key, trade2Row.key))
      .run();

    // Cached excursion in tradeExcursions table
    const updatedTrade2 = db.select().from(trades).where(eq(trades.key, trade2Row.key)).get()!;
    const fp2 = estimateFingerprint(rowToTrade(updatedTrade2));

    db.insert(tradeExcursions)
      .values({
        tradeKey: trade2Row.key,
        fingerprint: fp2,
        provider: "csv",
        symbol: "MSFT",
        resolution: "1m",
        fetchedAt: "2026-09-15T16:00:00Z",
        estimateJson: JSON.stringify({
          mae: -110,
          mfe: 15,
          sampledBars: 60,
          excludedBars: 0,
          warnings: [],
        }),
      })
      .run();

    // 5. Day note & day attachment
    db.insert(journalDays)
      .values({
        date: "2026-09-15",
        note: "## Day Reflection\nRough day with 2 disciplined stopped-out trades.",
        updatedAt: "2026-09-15T18:00:00Z",
      })
      .run();

    db.insert(attachments)
      .values({
        id: "att-day-1",
        ownerType: "day",
        ownerId: "2026-09-15",
        name: "market-overview.png",
        mime: "image/png",
        size: 8192,
        data: Buffer.from("fake-day-png"),
        createdAt: "2026-09-15T18:05:00Z",
      })
      .run();

    // 6. Execute export endpoint
    const response = await getExport(
      new Request("http://localhost/api/journal/2026-09-15/export"),
      { params: Promise.resolve({ date: "2026-09-15" }) },
    );

    expect(response.status).toBe(200);
    const data = await response.json();

    // Direct JSON output, not an envelope
    expect(data).toHaveProperty("date", "2026-09-15");
    expect(data).toHaveProperty("exportedAt");
    expect(data).toHaveProperty("timeZone", "UTC");
    expect(data.note).toBe("## Day Reflection\nRough day with 2 disciplined stopped-out trades.");
    expect(data.noteUpdatedAt).toBe("2026-09-15T18:00:00Z");

    // Scope
    expect(data.scope).toEqual({
      label: "All trades",
      filters: {},
      accountNames: ["Main Trading Account"],
      currencies: ["USD"],
    });

    // Metrics
    expect(data.metrics.closedTrades).toBe(2);
    expect(data.metrics.wins).toBe(0);
    expect(data.metrics.losses).toBe(2);
    expect(data.profitFactorIsInfinite).toBe(false);
    expect(data.metrics.netPnl).toBeLessThan(0);

    // Intraday curve
    expect(Array.isArray(data.intraday)).toBe(true);
    expect(data.intraday.length).toBeGreaterThan(0);
    expect(data.intraday.at(-1)?.cumNetPnl).toBe(data.metrics.netPnl);

    // Day attachments metadata only
    expect(data.attachments).toHaveLength(1);
    expect(data.attachments[0]).toEqual({
      id: "att-day-1",
      name: "market-overview.png",
      mime: "image/png",
      size: 8192,
      createdAt: "2026-09-15T18:05:00Z",
    });
    expect(data.attachments[0]).not.toHaveProperty("data");

    // Trades
    expect(data.trades).toHaveLength(2);

    // Deterministic ordering: closedAt ascending
    expect(data.trades[0].symbol).toBe("AAPL"); // closed at 15:00
    expect(data.trades[1].symbol).toBe("MSFT"); // closed at 15:30

    // Inspect Trade 1
    const t1 = data.trades[0];
    expect(t1.accountName).toBe("Main Trading Account");
    expect(t1.currency).toBe("USD");
    expect(t1.direction).toBe("long");
    expect(t1.status).toBe("loss");
    expect(t1.quantity).toBe(10);
    expect(t1.avgEntry).toBe(100);
    expect(t1.avgExit).toBe(90);
    expect(t1.netPnl).toBe((90 - 100) * 10 - 2); // -102
    expect(t1.stopLoss).toBe(95);
    expect(t1.profitTarget).toBe(110);
    expect(t1.rating).toBe(3);
    expect(t1.reviewedAt).toBe("2026-09-15T16:00:00Z");
    expect(t1.notes).toBe("Markdown note with **bold text** and `code`");
    expect(t1.tags).toEqual(["reversal", "fomc"]);
    expect(t1.mistakes).toEqual(["chasing"]);

    // Playbook rules
    expect(t1.playbook).toEqual({
      id: "pb1",
      name: "Breakout Strategy",
      description: "Standard high timeframe breakout with defined stops",
      rules: [
        { rule: "Trend aligned", followed: true },
        { rule: "Risk <= 1%", followed: false },
      ],
    });

    // Executions
    expect(t1.executions).toHaveLength(2);
    expect(t1.executions[0]).toEqual({
      id: "fill-1",
      executedAt: "2026-09-15T14:00:00Z",
      side: "buy",
      quantity: 10,
      price: 100,
      fee: 1,
      source: "manual",
    });
    expect(t1.executions[1]).toEqual({
      id: "fill-2",
      executedAt: "2026-09-15T15:00:00Z",
      side: "sell",
      quantity: 10,
      price: 90,
      fee: 1,
      source: "manual",
    });

    // Running PnL has openedAt zero baseline, matches exits + fees and ends at netPnl
    expect(t1.runningPnl).toHaveLength(2);
    expect(t1.runningPnl[0]).toEqual({ t: "2026-09-15T14:00:00Z", cumNetPnl: 0 });
    expect(t1.runningPnl[1]).toEqual({ t: "2026-09-15T15:00:00Z", cumNetPnl: t1.netPnl });
    expect(t1.contractMultiplier).toBe(1);

    // Trade attachments metadata only (PDF and PNG)
    expect(t1.attachments).toHaveLength(2);
    expect(t1.attachments[0]).toEqual({
      id: "att-img-1",
      name: "chart-setup.png",
      mime: "image/png",
      size: 2048,
      createdAt: "2026-09-15T15:05:00Z",
    });
    expect(t1.attachments[1]).toEqual({
      id: "att-pdf-1",
      name: "trade-analysis.pdf",
      mime: "application/pdf",
      size: 4096,
      createdAt: "2026-09-15T15:10:00Z",
    });
    expect(t1.attachments[0]).not.toHaveProperty("data");
    expect(t1.attachments[1]).not.toHaveProperty("data");

    // Inspect Trade 2
    const t2 = data.trades[1];
    expect(t2.symbol).toBe("MSFT");
    expect(t2.targetHit).toBe("stop_loss");
    expect(t2.rating).toBe(2);

    // Cached excursions through helper
    expect(t2.excursions).toEqual({
      mae: -110,
      mfe: 15,
      sampledBars: 60,
      resolution: "1m",
      provider: "csv",
      fetchedAt: "2026-09-15T16:00:00Z",
    });

    // AI reviews through listTradeAiReviews helper
    expect(t2.aiReviews).toEqual([
      {
        id: "rev-1",
        createdAt: "2026-09-15T17:00:00Z",
        content: "AI review critique: cut losses promptly.",
        provider: "openai",
        model: "gpt-4o",
      },
    ]);
  });

  it("excludes trades from other accounts, other days, and open positions", async () => {
    db.insert(accounts)
      .values([
        {
          id: "acc1",
          name: "Account One",
          kind: "manual",
          currency: "USD",
          createdAt: "2026-01-01",
        },
        {
          id: "acc2",
          name: "Account Two",
          kind: "manual",
          currency: "EUR",
          createdAt: "2026-01-01",
        },
      ])
      .run();

    // Trade A: in acc1, closed on 2026-09-15
    db.insert(executions)
      .values([
        {
          id: "fill-a1",
          accountId: "acc1",
          symbol: "NVDA",
          side: "buy",
          quantity: 1,
          price: 100,
          fee: 0,
          executedAt: "2026-09-15T10:00:00Z",
          source: "manual",
          contentHash: "hash-a1",
          createdAt: "2026-09-15T10:00:00Z",
        },
        {
          id: "fill-a2",
          accountId: "acc1",
          symbol: "NVDA",
          side: "sell",
          quantity: 1,
          price: 110,
          fee: 0,
          executedAt: "2026-09-15T11:00:00Z",
          source: "manual",
          contentHash: "hash-a2",
          createdAt: "2026-09-15T11:00:00Z",
        },
      ])
      .run();

    // Trade B: in acc2, closed on 2026-09-15
    db.insert(executions)
      .values([
        {
          id: "fill-b1",
          accountId: "acc2",
          symbol: "TSLA",
          side: "buy",
          quantity: 2,
          price: 200,
          fee: 0,
          executedAt: "2026-09-15T12:00:00Z",
          source: "manual",
          contentHash: "hash-b1",
          createdAt: "2026-09-15T12:00:00Z",
        },
        {
          id: "fill-b2",
          accountId: "acc2",
          symbol: "TSLA",
          side: "sell",
          quantity: 2,
          price: 220,
          fee: 0,
          executedAt: "2026-09-15T13:00:00Z",
          source: "manual",
          contentHash: "hash-b2",
          createdAt: "2026-09-15T13:00:00Z",
        },
      ])
      .run();

    // Trade C: in acc1, closed on a different day (2026-09-16)
    db.insert(executions)
      .values([
        {
          id: "fill-c1",
          accountId: "acc1",
          symbol: "AMD",
          side: "buy",
          quantity: 10,
          price: 50,
          fee: 0,
          executedAt: "2026-09-16T10:00:00Z",
          source: "manual",
          contentHash: "hash-c1",
          createdAt: "2026-09-16T10:00:00Z",
        },
        {
          id: "fill-c2",
          accountId: "acc1",
          symbol: "AMD",
          side: "sell",
          quantity: 10,
          price: 55,
          fee: 0,
          executedAt: "2026-09-16T11:00:00Z",
          source: "manual",
          contentHash: "hash-c2",
          createdAt: "2026-09-16T11:00:00Z",
        },
      ])
      .run();

    // Trade D: in acc1, OPEN trade on 2026-09-15 (only buy fill)
    db.insert(executions)
      .values([
        {
          id: "fill-d1",
          accountId: "acc1",
          symbol: "INTC",
          side: "buy",
          quantity: 10,
          price: 30,
          fee: 0,
          executedAt: "2026-09-15T09:00:00Z",
          source: "manual",
          contentHash: "hash-d1",
          createdAt: "2026-09-15T09:00:00Z",
        },
      ])
      .run();

    rebuildAccount("acc1");
    rebuildAccount("acc2");

    // Query for 2026-09-15 filtered to acc1
    const res = await getExport(
      new Request("http://localhost/api/journal/2026-09-15/export?accounts=acc1"),
      { params: Promise.resolve({ date: "2026-09-15" }) },
    );
    expect(res.status).toBe(200);
    const data = await res.json();

    // Only NVDA should be present!
    expect(data.trades).toHaveLength(1);
    expect(data.trades[0].symbol).toBe("NVDA");
    expect(data.scope.accountNames).toEqual(["Account One"]);
    expect(data.scope.currencies).toEqual(["USD"]);

    // If query without accounts filter, both acc1 and acc2 trades on 2026-09-15 are returned,
    // but the open trade (INTC) and other-day trade (AMD) remain excluded!
    const resAll = await getExport(new Request("http://localhost/api/journal/2026-09-15/export"), {
      params: Promise.resolve({ date: "2026-09-15" }),
    });
    const dataAll = await resAll.json();
    expect(dataAll.trades.map((t: { symbol: string }) => t.symbol).sort()).toEqual([
      "NVDA",
      "TSLA",
    ]);
    expect(dataAll.scope.accountNames).toEqual(["Account One", "Account Two"]);
    expect(dataAll.scope.currencies).toEqual(["EUR", "USD"]);
  });

  it("respects timezone boundary according to configured settings.timeZone", async () => {
    // Set journal timezone to America/New_York (UTC-4 in September)
    setSetting("timeZone", "America/New_York");

    db.insert(accounts)
      .values({
        id: "acc-tz",
        name: "TZ Account",
        kind: "manual",
        currency: "USD",
        createdAt: "2026-01-01",
      })
      .run();

    // Trade closes at 2026-09-16T02:30:00Z
    // In America/New_York (UTC-4): this is 2026-09-15T22:30:00 (i.e. September 15!)
    db.insert(executions)
      .values([
        {
          id: "fill-tz1",
          accountId: "acc-tz",
          symbol: "SPY",
          side: "buy",
          quantity: 1,
          price: 500,
          fee: 0,
          executedAt: "2026-09-16T02:00:00Z",
          source: "manual",
          contentHash: "hash-tz1",
          createdAt: "2026-09-16T02:00:00Z",
        },
        {
          id: "fill-tz2",
          accountId: "acc-tz",
          symbol: "SPY",
          side: "sell",
          quantity: 1,
          price: 510,
          fee: 0,
          executedAt: "2026-09-16T02:30:00Z",
          source: "manual",
          contentHash: "hash-tz2",
          createdAt: "2026-09-16T02:30:00Z",
        },
      ])
      .run();

    rebuildAccount("acc-tz");

    // Under America/New_York: 2026-09-15 includes this trade
    const res15 = await getExport(new Request("http://localhost/api/journal/2026-09-15/export"), {
      params: Promise.resolve({ date: "2026-09-15" }),
    });
    expect(res15.status).toBe(200);
    const data15 = await res15.json();
    expect(data15.trades).toHaveLength(1);
    expect(data15.trades[0].symbol).toBe("SPY");
    expect(data15.timeZone).toBe("America/New_York");

    // Under America/New_York: 2026-09-16 does NOT include this trade
    const res16 = await getExport(new Request("http://localhost/api/journal/2026-09-16/export"), {
      params: Promise.resolve({ date: "2026-09-16" }),
    });
    expect(res16.status).toBe(200);
    const data16 = await res16.json();
    expect(data16.trades).toHaveLength(0);
  });

  it("never exposes secret fields or credentials, and does not call live quotes or live AI", async () => {
    db.insert(accounts)
      .values({
        id: "acc-secret",
        name: "Secret Broker Account",
        kind: "sync",
        currency: "USD",
        credentialsEnc: "VERY_CONFIDENTIAL_ENCRYPTED_BROKER_KEY",
        snapshotJson: JSON.stringify({ brokerToken: "RAW_TOKEN_123" }),
        createdAt: "2026-01-01",
      })
      .run();

    db.insert(executions)
      .values([
        {
          id: "fill-s1",
          accountId: "acc-secret",
          symbol: "META",
          side: "buy",
          quantity: 1,
          price: 300,
          fee: 0,
          executedAt: "2026-09-15T10:00:00Z",
          source: "sync",
          importMetadataJson: JSON.stringify({ rawBrokerPayload: "DO_NOT_EXPOSE" }),
          contentHash: "hash-secret-fill",
          createdAt: "2026-09-15T10:00:00Z",
        },
        {
          id: "fill-s2",
          accountId: "acc-secret",
          symbol: "META",
          side: "sell",
          quantity: 1,
          price: 290,
          fee: 0,
          executedAt: "2026-09-15T11:00:00Z",
          source: "sync",
          contentHash: "hash-secret-exit",
          createdAt: "2026-09-15T11:00:00Z",
        },
      ])
      .run();

    rebuildAccount("acc-secret");

    const res = await getExport(new Request("http://localhost/api/journal/2026-09-15/export"), {
      params: Promise.resolve({ date: "2026-09-15" }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();

    // Verify secret fields and raw payloads are completely absent
    expect(text).not.toContain("VERY_CONFIDENTIAL_ENCRYPTED_BROKER_KEY");
    expect(text).not.toContain("RAW_TOKEN_123");
    expect(text).not.toContain("DO_NOT_EXPOSE");
    expect(text).not.toContain("credentialsEnc");
    expect(text).not.toContain("importMetadataJson");
    expect(text).not.toContain("contentHash");
  });

  it("is strictly readonly: no records are written or altered by running the export", async () => {
    db.insert(accounts)
      .values({
        id: "acc-ro",
        name: "Readonly Account",
        kind: "manual",
        currency: "USD",
        createdAt: "2026-01-01",
      })
      .run();

    db.insert(executions)
      .values([
        {
          id: "fill-ro1",
          accountId: "acc-ro",
          symbol: "GOOG",
          side: "buy",
          quantity: 1,
          price: 150,
          fee: 0,
          executedAt: "2026-09-15T10:00:00Z",
          source: "manual",
          contentHash: "hash-ro1",
          createdAt: "2026-09-15T10:00:00Z",
        },
        {
          id: "fill-ro2",
          accountId: "acc-ro",
          symbol: "GOOG",
          side: "sell",
          quantity: 1,
          price: 155,
          fee: 0,
          executedAt: "2026-09-15T11:00:00Z",
          source: "manual",
          contentHash: "hash-ro2",
          createdAt: "2026-09-15T11:00:00Z",
        },
      ])
      .run();

    rebuildAccount("acc-ro");

    const countsBefore = {
      accounts: db.select().from(accounts).all().length,
      trades: db.select().from(trades).all().length,
      executions: db.select().from(executions).all().length,
      journalDays: db.select().from(journalDays).all().length,
      attachments: db.select().from(attachments).all().length,
      tradeExcursions: db.select().from(tradeExcursions).all().length,
    };

    const res = await getExport(new Request("http://localhost/api/journal/2026-09-15/export"), {
      params: Promise.resolve({ date: "2026-09-15" }),
    });
    expect(res.status).toBe(200);

    const countsAfter = {
      accounts: db.select().from(accounts).all().length,
      trades: db.select().from(trades).all().length,
      executions: db.select().from(executions).all().length,
      journalDays: db.select().from(journalDays).all().length,
      attachments: db.select().from(attachments).all().length,
      tradeExcursions: db.select().from(tradeExcursions).all().length,
    };

    expect(countsAfter).toEqual(countsBefore);
  });

  it("rejects malformed calendar dates and invalid or unknown filters with 400", async () => {
    // Malformed calendar dates (regex or invalid day like Feb 30)
    for (const badDate of ["not-a-date", "2026-02-30", "2026-13-01", "2026-04-31", "2026-00-10"]) {
      const res = await getExport(new Request(`http://localhost/api/journal/${badDate}/export`), {
        params: Promise.resolve({ date: badDate }),
      });
      expect(res.status, `date ${badDate} should fail`).toBe(400);
      const json = await res.json();
      expect(json.error).toMatch(/valid calendar YYYY-MM-DD/i);
    }

    // Unknown query filter
    const resUnknown = await getExport(
      new Request("http://localhost/api/journal/2026-09-15/export?unrecognizedFilter=val"),
      { params: Promise.resolve({ date: "2026-09-15" }) },
    );
    expect(resUnknown.status).toBe(400);
    expect((await resUnknown.json()).error).toMatch(/Unknown filter/i);

    // Invalid filter values
    const resDirection = await getExport(
      new Request("http://localhost/api/journal/2026-09-15/export?direction=sideways"),
      { params: Promise.resolve({ date: "2026-09-15" }) },
    );
    expect(resDirection.status).toBe(400);

    // Inverted numeric range
    const resRange = await getExport(
      new Request("http://localhost/api/journal/2026-09-15/export?pnlMin=100&pnlMax=50"),
      { params: Promise.resolve({ date: "2026-09-15" }) },
    );
    expect(resRange.status).toBe(400);

    // Non-existent account
    const resAcc = await getExport(
      new Request("http://localhost/api/journal/2026-09-15/export?accounts=nonexistent-account-id"),
      { params: Promise.resolve({ date: "2026-09-15" }) },
    );
    expect(resAcc.status).toBe(400);
  });

  it("calculates runningPnL across all partial exits and scaleouts without restricting to export date", async () => {
    db.insert(accounts)
      .values({
        id: "acc-scale",
        name: "Scaling Account",
        kind: "manual",
        currency: "USD",
        createdAt: "2026-01-01",
      })
      .run();

    // Multi-exit trade spanning 2 days:
    // Entry: 2026-09-14 buy 10 @ 100, fee 1
    // Scaleout 1: 2026-09-14 sell 5 @ 105, fee 1
    // Final exit: 2026-09-15 sell 5 @ 110, fee 1 (closes trade on 2026-09-15)
    db.insert(executions)
      .values([
        {
          id: "fill-scale-entry",
          accountId: "acc-scale",
          symbol: "SCALE",
          side: "buy",
          quantity: 10,
          price: 100,
          fee: 1,
          executedAt: "2026-09-14T14:00:00Z",
          source: "manual",
          contentHash: "hash-scale-1",
          createdAt: "2026-09-14T14:00:00Z",
        },
        {
          id: "fill-scale-exit1",
          accountId: "acc-scale",
          symbol: "SCALE",
          side: "sell",
          quantity: 5,
          price: 105,
          fee: 1,
          executedAt: "2026-09-14T16:00:00Z",
          source: "manual",
          contentHash: "hash-scale-2",
          createdAt: "2026-09-14T16:00:00Z",
        },
        {
          id: "fill-scale-exit2",
          accountId: "acc-scale",
          symbol: "SCALE",
          side: "sell",
          quantity: 5,
          price: 110,
          fee: 1,
          executedAt: "2026-09-15T15:00:00Z",
          source: "manual",
          contentHash: "hash-scale-3",
          createdAt: "2026-09-15T15:00:00Z",
        },
      ])
      .run();

    rebuildAccount("acc-scale");

    const res = await getExport(new Request("http://localhost/api/journal/2026-09-15/export"), {
      params: Promise.resolve({ date: "2026-09-15" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.trades).toHaveLength(1);

    const trade = data.trades[0];
    expect(trade.symbol).toBe("SCALE");
    // runningPnL prepends openedAt zero baseline and has BOTH exits: the scaleout on Sept 14 and final exit on Sept 15!
    expect(trade.runningPnl).toHaveLength(3);
    expect(trade.runningPnl[0]).toEqual({ t: "2026-09-14T14:00:00Z", cumNetPnl: 0 });
    expect(trade.runningPnl[1].t).toBe("2026-09-14T16:00:00Z");
    expect(trade.runningPnl[2].t).toBe("2026-09-15T15:00:00Z");
    expect(trade.runningPnl[2].cumNetPnl).toBe(trade.netPnl);
  });

  it("does not leak unused or archived accounts or currencies into scope when unfiltered", async () => {
    db.insert(accounts)
      .values([
        {
          id: "acc-active-usd",
          name: "Active USD Account",
          kind: "manual",
          currency: "USD",
          createdAt: "2026-01-01",
        },
        {
          id: "acc-archived-eur",
          name: "Archived Private EUR Vault",
          kind: "manual",
          currency: "EUR",
          archivedAt: "2026-01-02",
          createdAt: "2026-01-01",
        },
      ])
      .run();

    // Only acc-active-usd has a trade on 2026-09-15
    db.insert(executions)
      .values([
        {
          id: "fill-usd-1",
          accountId: "acc-active-usd",
          symbol: "AAPL",
          side: "buy",
          quantity: 1,
          price: 150,
          fee: 0,
          executedAt: "2026-09-15T10:00:00Z",
          source: "manual",
          contentHash: "hash-usd-1",
          createdAt: "2026-09-15T10:00:00Z",
        },
        {
          id: "fill-usd-2",
          accountId: "acc-active-usd",
          symbol: "AAPL",
          side: "sell",
          quantity: 1,
          price: 155,
          fee: 0,
          executedAt: "2026-09-15T11:00:00Z",
          source: "manual",
          contentHash: "hash-usd-2",
          createdAt: "2026-09-15T11:00:00Z",
        },
      ])
      .run();

    rebuildAccount("acc-active-usd");

    // Unfiltered request: scope must ONLY derive from actual day trades, not all stored accounts!
    const res = await getExport(new Request("http://localhost/api/journal/2026-09-15/export"), {
      params: Promise.resolve({ date: "2026-09-15" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();

    // Verify EUR account name and EUR currency are completely absent
    expect(data.scope.accountNames).toEqual(["Active USD Account"]);
    expect(data.scope.currencies).toEqual(["USD"]);
    expect(JSON.stringify(data.scope)).not.toContain("Archived Private EUR Vault");
    expect(JSON.stringify(data.scope)).not.toContain("EUR");

    // Explicit accounts filter retains honest explicit scope
    const resFiltered = await getExport(
      new Request("http://localhost/api/journal/2026-09-15/export?accounts=acc-active-usd"),
      { params: Promise.resolve({ date: "2026-09-15" }) },
    );
    expect(resFiltered.status).toBe(200);
    const dataFiltered = await resFiltered.json();
    expect(dataFiltered.scope.accountNames).toEqual(["Active USD Account"]);
    expect(dataFiltered.scope.currencies).toEqual(["USD"]);
  });

  it("exports null contractMultiplier for unconfigured derivatives instead of inventing 1", async () => {
    db.insert(accounts)
      .values({
        id: "acc-deriv",
        name: "Futures Account",
        kind: "manual",
        currency: "USD",
        createdAt: "2026-01-01",
      })
      .run();

    // Futures trade without a configured multiplier in settings.multipliers
    db.insert(executions)
      .values([
        {
          id: "fill-fut-1",
          accountId: "acc-deriv",
          symbol: "ES",
          assetClass: "futures",
          side: "buy",
          quantity: 1,
          price: 5000,
          fee: 2.5,
          executedAt: "2026-09-15T10:00:00Z",
          source: "manual",
          contentHash: "hash-fut-1",
          createdAt: "2026-09-15T10:00:00Z",
        },
        {
          id: "fill-fut-2",
          accountId: "acc-deriv",
          symbol: "ES",
          assetClass: "futures",
          side: "sell",
          quantity: 1,
          price: 5010,
          fee: 2.5,
          executedAt: "2026-09-15T11:00:00Z",
          source: "manual",
          contentHash: "hash-fut-2",
          createdAt: "2026-09-15T11:00:00Z",
        },
      ])
      .run();

    rebuildAccount("acc-deriv");

    const res = await getExport(new Request("http://localhost/api/journal/2026-09-15/export"), {
      params: Promise.resolve({ date: "2026-09-15" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.trades).toHaveLength(1);
    expect(data.trades[0].symbol).toBe("ES");
    expect(data.trades[0].assetClass).toBe("futures");
    // Contract multiplier must be null (unknown), NOT invented 1!
    expect(data.trades[0].contractMultiplier).toBeNull();
  });

  it("accepts valid finite scientific notation in numeric filters", async () => {
    const res = await getExport(
      new Request("http://localhost/api/journal/2026-09-15/export?pnlMin=-1e5&pnlMax=1e5"),
      { params: Promise.resolve({ date: "2026-09-15" }) },
    );
    expect(res.status).toBe(200);
  });
});
