import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalDir = process.env.JOURNAL_DATA_DIR;
const scratch = mkdtempSync(join(tmpdir(), "journal-ai-history-test-"));
process.env.JOURNAL_DATA_DIR = scratch;

const { db, settings, accounts, executions, trades, journalDays } = await import("../src/db");
const { eq } = await import("drizzle-orm");
const { setSetting, setAiKey, getSetting } = await import("../src/server/settings");
const { rebuildAccount } = await import("../src/server/rebuild");
const { listTradeAiReviews, appendTradeAiReview, listAllTradeAiReviews, clearTradeAiReviews } =
  await import("../src/server/ai-review-history");
const { GET: critiqueGet, POST: critiquePost } = await import("../src/app/api/ai/critique/route");
const { GET: exportGet } = await import("../src/app/api/export/route");
const { DELETE: tradeDelete } = await import("../src/app/api/trades/[key]/route");
const { POST: bulkTradesPost } = await import("../src/app/api/trades/bulk/route");
const { DELETE: accountDelete } = await import("../src/app/api/accounts/[id]/route");
const { POST: accountActionsPost } = await import("../src/app/api/accounts/[id]/actions/route");

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));

const post = (
  handler: (req: Request) => Promise<Response>,
  body: unknown,
  url = "http://localhost/api/ai/critique",
) =>
  handler(
    new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const get = (
  handler: (req: Request) => Promise<Response>,
  url = "http://localhost/api/ai/critique",
) =>
  handler(
    new Request(url, {
      method: "GET",
    }),
  );

const mockOpenAiSuccess = (text: string, model = "gpt-4.1-mini") =>
  vi.fn(async () =>
    Response.json({
      id: "resp_fixture",
      created_at: Math.floor(Date.now() / 1000),
      model,
      status: "completed",
      output: [
        {
          type: "message",
          id: "msg_fixture",
          role: "assistant",
          content: [{ type: "output_text", text, annotations: [] }],
        },
      ],
      usage: { input_tokens: 15, output_tokens: 10, total_tokens: 25 },
    }),
  );

beforeEach(() => {
  db.delete(settings).run();
  db.delete(executions).run();
  db.delete(trades).run();
  db.delete(accounts).run();
  db.delete(journalDays).run();

  // Create test account
  db.insert(accounts)
    .values({
      id: "acc_1",
      name: "Primary Trading Account",
      currency: "USD",
      kind: "manual",
      profitCalcMethod: "fifo",
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    .run();

  // Create sample executions for trade_1
  db.insert(executions)
    .values([
      {
        id: "exec_1_buy",
        accountId: "acc_1",
        symbol: "NQ",
        side: "buy",
        quantity: 1,
        price: 20000,
        fee: 2.0,
        executedAt: "2026-11-05T14:30:00.000Z",
        source: "manual",
        contentHash: "hash_1_buy",
        createdAt: "2026-11-05T14:30:00.000Z",
      },
      {
        id: "exec_1_sell",
        accountId: "acc_1",
        symbol: "NQ",
        side: "sell",
        quantity: 1,
        price: 20100,
        fee: 2.0,
        executedAt: "2026-11-05T15:00:00.000Z",
        source: "manual",
        contentHash: "hash_1_sell",
        createdAt: "2026-11-05T15:00:00.000Z",
      },
    ])
    .run();

  // Create trade_1
  db.insert(trades)
    .values({
      key: "trade_1",
      accountId: "acc_1",
      symbol: "NQ",
      direction: "long",
      status: "win",
      quantity: 1,
      openQuantity: 0,
      avgEntry: 20000,
      avgExit: 20100,
      openedAt: "2026-11-05T14:30:00.000Z",
      closedAt: "2026-11-05T15:00:00.000Z",
      grossPnl: 2000,
      netPnl: 1996,
      fees: 4,
      executionCount: 2,
      notes: "Original trader note: Held through pullbacks patiently.",
      tagsJson: JSON.stringify(["breakout", "trend-continuation"]),
      mistakesJson: JSON.stringify([]),
      executionIdsJson: JSON.stringify(["exec_1_buy", "exec_1_sell"]),
      exitsJson: JSON.stringify([]),
    })
    .run();

  // Create executions and trade_2 for isolation testing
  db.insert(executions)
    .values([
      {
        id: "exec_2_buy",
        accountId: "acc_1",
        symbol: "ES",
        side: "buy",
        quantity: 1,
        price: 5800,
        fee: 2.5,
        executedAt: "2026-11-06T14:30:00.000Z",
        source: "manual",
        contentHash: "hash_2_buy",
        createdAt: "2026-11-06T14:30:00.000Z",
      },
    ])
    .run();

  db.insert(trades)
    .values({
      key: "trade_2",
      accountId: "acc_1",
      symbol: "ES",
      direction: "long",
      status: "open",
      quantity: 1,
      openQuantity: 1,
      avgEntry: 5800,
      avgExit: null,
      openedAt: "2026-11-06T14:30:00.000Z",
      closedAt: null,
      grossPnl: 0,
      netPnl: -2.5,
      fees: 2.5,
      executionCount: 1,
      notes: "Trade 2 trader notes.",
      tagsJson: JSON.stringify(["reversal"]),
      mistakesJson: JSON.stringify([]),
      executionIdsJson: JSON.stringify(["exec_2_buy"]),
      exitsJson: JSON.stringify([]),
    })
    .run();

  setSetting("aiProvider", "openai");
  setSetting("openaiModel", "gpt-4.1-mini");
  setAiKey("openai", "test-secret-openai-key");

  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("UNEXPECTED_LIVE_NETWORK_CALL");
    }),
  );
});

afterAll(() => {
  if (originalDir) process.env.JOURNAL_DATA_DIR = originalDir;
  else delete process.env.JOURNAL_DATA_DIR;
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

describe("AI Critique History Storage Helper (ai-review-history.ts)", () => {
  it("returns empty array for unknown or empty trade keys", () => {
    expect(listTradeAiReviews("")).toEqual([]);
    expect(listTradeAiReviews("   ")).toEqual([]);
    expect(listTradeAiReviews("non_existent_trade")).toEqual([]);
  });

  it("appends and lists critique reviews in ascending order (oldest -> newest)", () => {
    const rev1 = appendTradeAiReview("trade_1", {
      content: "First review: Good entry sizing.",
      provider: "openai",
      model: "gpt-4.1-mini",
      createdAt: "2026-11-06T10:00:00.000Z",
    });

    const rev2 = appendTradeAiReview("trade_1", {
      content: "Second review: Trailed stop effectively.",
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
      createdAt: "2026-11-06T11:00:00.000Z",
    });

    const history = listTradeAiReviews("trade_1");
    expect(history).toHaveLength(2);
    expect(history[0]!).toEqual({
      id: rev1.id,
      createdAt: "2026-11-06T10:00:00.000Z",
      content: "First review: Good entry sizing.",
      provider: "openai",
      model: "gpt-4.1-mini",
    });
    expect(history[1]!).toEqual({
      id: rev2.id,
      createdAt: "2026-11-06T11:00:00.000Z",
      content: "Second review: Trailed stop effectively.",
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
    });

    // Verification that NO secrets/keys/prompts are stored
    const rawSaved = getSetting("tradeAiReviews:trade_1");
    expect(rawSaved).not.toContain("test-secret-openai-key");
    expect(rawSaved).not.toContain("fullPrompt");
    expect(rawSaved).not.toContain("effectiveSystemPrompt");
  });

  it("exports all reviews across trades with tradeKey attached", () => {
    appendTradeAiReview("trade_1", {
      content: "Critique for trade 1",
      provider: "openai",
      model: "gpt-4.1-mini",
      createdAt: "2026-11-06T10:00:00.000Z",
    });
    appendTradeAiReview("trade_2", {
      content: "Critique for trade 2",
      provider: "openai",
      model: "gpt-4.1-mini",
      createdAt: "2026-11-06T12:00:00.000Z",
    });

    const all = listAllTradeAiReviews();
    expect(all).toHaveLength(2);
    expect(all[0]!.tradeKey).toBe("trade_1");
    expect(all[0]!.content).toBe("Critique for trade 1");
    expect(all[1]!.tradeKey).toBe("trade_2");
    expect(all[1]!.content).toBe("Critique for trade 2");
  });
});

describe("Generation vs Preview / Cancel", () => {
  it("preview request generates preview with ZERO provider calls and stores NOTHING in history", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    const res = await post(critiquePost, {
      key: "trade_1",
      preview: true,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.preview).toBeDefined();
    expect(body.critique).toBeUndefined();

    // Zero AI provider calls
    expect(fetcher).not.toHaveBeenCalled();

    // Persists nothing in history
    expect(listTradeAiReviews("trade_1")).toEqual([]);
  });

  it("canceling preview makes zero AI provider calls and persists nothing", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    // Step 1: User requested preview
    const previewRes = await post(critiquePost, {
      key: "trade_1",
      preview: true,
    });
    expect(previewRes.status).toBe(200);

    // Step 2: User canceled preview dialog (never posts confirm)
    // No subsequent calls made

    expect(fetcher).not.toHaveBeenCalled();
    expect(listTradeAiReviews("trade_1")).toHaveLength(0);
  });

  it("confirm send generates critique via provider and persists to history", async () => {
    const fetcher = mockOpenAiSuccess("Excellent entry execution and sizing discipline.");
    vi.stubGlobal("fetch", fetcher);

    // 1. Preview
    const previewRes = await post(critiquePost, { key: "trade_1", preview: true });
    const { preview } = await previewRes.json();

    // 2. Confirm
    const confirmRes = await post(critiquePost, {
      key: "trade_1",
      snapshotFingerprint: preview.snapshotFingerprint,
    });

    expect(confirmRes.status).toBe(200);
    const confirmBody = await confirmRes.json();
    expect(confirmBody.critique).toBe("Excellent entry execution and sizing discipline.");
    expect(confirmBody.review).toBeDefined();
    expect(confirmBody.review.content).toBe("Excellent entry execution and sizing discipline.");
    expect(confirmBody.review.provider).toBe("openai");
    expect(confirmBody.review.model).toBe("gpt-4.1-mini");

    expect(fetcher).toHaveBeenCalledTimes(1);

    // 3. Verified in history
    const history = listTradeAiReviews("trade_1");
    expect(history).toHaveLength(1);
    expect(history[0]!.content).toBe("Excellent entry execution and sizing discipline.");
    expect(history[0]!.provider).toBe("openai");
    expect(history[0]!.model).toBe("gpt-4.1-mini");
  });
});

describe("Multiple Generations & Chronological Persistence", () => {
  it("persists successive generations and serves them in ascending order", async () => {
    const fetcher = vi
      .fn()
      .mockImplementationOnce(mockOpenAiSuccess("Critique #1: Initial review."))
      .mockImplementationOnce(mockOpenAiSuccess("Critique #2: Updated review after notes review."));
    vi.stubGlobal("fetch", fetcher);

    // First generation
    const res1 = await post(critiquePost, { key: "trade_1" });
    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    expect(body1.critique).toBe("Critique #1: Initial review.");

    // Second generation
    const res2 = await post(critiquePost, { key: "trade_1" });
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.critique).toBe("Critique #2: Updated review after notes review.");

    const history = listTradeAiReviews("trade_1");
    expect(history).toHaveLength(2);
    expect(history[0]!.content).toBe("Critique #1: Initial review.");
    expect(history[1]!.content).toBe("Critique #2: Updated review after notes review.");
    expect(new Date(history[0]!.createdAt).getTime()).toBeLessThanOrEqual(
      new Date(history[1]!.createdAt).getTime(),
    );
  });
});

describe("Trade Isolation, Reload, and Notes Safety", () => {
  it("isolates critique history between different trades", async () => {
    const fetcher = vi
      .fn()
      .mockImplementationOnce(mockOpenAiSuccess("Critique for trade 1."))
      .mockImplementationOnce(mockOpenAiSuccess("Critique for trade 2."));
    vi.stubGlobal("fetch", fetcher);

    await post(critiquePost, { key: "trade_1" });
    await post(critiquePost, { key: "trade_2" });

    const trade1History = listTradeAiReviews("trade_1");
    const trade2History = listTradeAiReviews("trade_2");

    expect(trade1History).toHaveLength(1);
    expect(trade1History[0]!.content).toBe("Critique for trade 1.");

    expect(trade2History).toHaveLength(1);
    expect(trade2History[0]!.content).toBe("Critique for trade 2.");
  });

  it("hydrates history on reload via GET /api/ai/critique without making AI provider calls", async () => {
    appendTradeAiReview("trade_1", {
      content: "Persisted critique from earlier session.",
      provider: "openai",
      model: "gpt-4.1-mini",
      createdAt: "2026-11-06T09:00:00.000Z",
    });

    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    const res = await get(critiqueGet, "http://localhost/api/ai/critique?key=trade_1");
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(fetcher).not.toHaveBeenCalled();
    expect(data.reviews).toHaveLength(1);
    expect(data.reviews[0].content).toBe("Persisted critique from earlier session.");
    expect(data.critique).toBe("Persisted critique from earlier session.");
  });

  it("never overwrites trader notes when storing critiques", async () => {
    const fetcher = mockOpenAiSuccess("AI critique content.");
    vi.stubGlobal("fetch", fetcher);

    const originalNote = "Original trader note: Held through pullbacks patiently.";
    const tradeBefore = db.select().from(trades).where(eq(trades.key, "trade_1")).get();
    expect(tradeBefore?.notes).toBe(originalNote);

    await post(critiquePost, { key: "trade_1" });

    const tradeAfter = db.select().from(trades).where(eq(trades.key, "trade_1")).get();
    expect(tradeAfter?.notes).toBe(originalNote);
  });
});

describe("Rebuild Preservation", () => {
  it("preserves AI critique history across account rebuilds", () => {
    // 1. Initial rebuild to get the rebuild-stable trade key
    rebuildAccount("acc_1");
    const initialTrades = db.select().from(trades).where(eq(trades.accountId, "acc_1")).all();
    expect(initialTrades.length).toBeGreaterThan(0);
    const stableTradeKey = initialTrades[0]!.key;

    // 2. Append a critique to this trade
    appendTradeAiReview(stableTradeKey, {
      content: "Critique generated before account rebuild.",
      provider: "openai",
      model: "gpt-4.1-mini",
    });

    expect(listTradeAiReviews(stableTradeKey)).toHaveLength(1);

    // 3. Trigger another complete account rebuild
    rebuildAccount("acc_1");

    // 4. Verify trade was rebuilt and exists in trades table
    const rebuiltTrade = db.select().from(trades).where(eq(trades.key, stableTradeKey)).get();
    expect(rebuiltTrade).toBeDefined();

    // 5. Verify critique history is completely intact!
    const reviewsAfterRebuild = listTradeAiReviews(stableTradeKey);
    expect(reviewsAfterRebuild).toHaveLength(1);
    expect(reviewsAfterRebuild[0]!.content).toBe("Critique generated before account rebuild.");
  });
});

describe("Strict Request Validation", () => {
  it("GET rejects missing, empty, or whitespace key with 400", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    const res1 = await get(critiqueGet, "http://localhost/api/ai/critique");
    expect(res1.status).toBe(400);

    const res2 = await get(critiqueGet, "http://localhost/api/ai/critique?key=");
    expect(res2.status).toBe(400);

    const res3 = await get(critiqueGet, "http://localhost/api/ai/critique?key=%20%20");
    expect(res3.status).toBe(400);

    expect(fetcher).not.toHaveBeenCalled();
  });

  it("GET returns 404 when requested trade does not exist", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    const res = await get(critiqueGet, "http://localhost/api/ai/critique?key=nonexistent_trade");
    expect(res.status).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("POST rejects invalid requests with 400 and makes zero provider calls", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    // Unknown field
    const res1 = await post(critiquePost, { key: "trade_1", unexpected: "injection" });
    expect(res1.status).toBe(400);

    // Non-existent trade
    const res2 = await post(critiquePost, { key: "unknown_trade" });
    expect(res2.status).toBe(400);

    // Invalid fingerprint format
    const res3 = await post(critiquePost, { key: "trade_1", snapshotFingerprint: "short" });
    expect(res3.status).toBe(400);

    expect(fetcher).not.toHaveBeenCalled();
    expect(listTradeAiReviews("trade_1")).toHaveLength(0);
  });
});

describe("Full JSON Export Backup", () => {
  it("includes AI review history in full JSON export with safe fields and no secrets", async () => {
    appendTradeAiReview("trade_1", {
      content: "Review for export.",
      provider: "openai",
      model: "gpt-4.1-mini",
      createdAt: "2026-11-06T15:00:00.000Z",
    });

    const res = await get(exportGet, "http://localhost/api/export?format=json");
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.aiReviews).toBeDefined();
    expect(Array.isArray(json.aiReviews)).toBe(true);
    expect(json.aiReviews).toHaveLength(1);
    expect(json.aiReviews[0]).toEqual({
      tradeKey: "trade_1",
      id: expect.any(String),
      createdAt: "2026-11-06T15:00:00.000Z",
      content: "Review for export.",
      provider: "openai",
      model: "gpt-4.1-mini",
    });

    // Verify no secret keys or prompt leakage in export output
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain("test-secret-openai-key");
  });
});

describe("Corruption Safety and Atomic Transaction Preservation", () => {
  it("throws explicit descriptive error when parsing malformed JSON and does not return empty array", () => {
    setSetting("tradeAiReviews:trade_1", "{ malformed json: not valid }");
    expect(() => listTradeAiReviews("trade_1")).toThrow(/invalid JSON/i);
  });

  it("throws explicit descriptive error when review history is not a JSON array", () => {
    setSetting("tradeAiReviews:trade_1", JSON.stringify({ not: "an array" }));
    expect(() => listTradeAiReviews("trade_1")).toThrow(/expected JSON array/i);
  });

  it("throws explicit descriptive error when review item is missing required fields", () => {
    setSetting(
      "tradeAiReviews:trade_1",
      JSON.stringify([{ id: "1", createdAt: "2026-11-06T00:00:00Z" }]),
    );
    expect(() => listTradeAiReviews("trade_1")).toThrow(/missing or invalid required fields/i);
  });

  it("appendTradeAiReview preserves corrupted KV without overwriting when parse fails", () => {
    const corruptedRaw = "{ corrupted: json that cannot be parsed }";
    setSetting("tradeAiReviews:trade_1", corruptedRaw);

    // Attempt to append to corrupted KV must throw and abort
    expect(() =>
      appendTradeAiReview("trade_1", {
        content: "New critique that must not overwrite corrupted data",
        provider: "openai",
        model: "gpt-4.1-mini",
      }),
    ).toThrow();

    // The corrupted raw value in database is completely preserved!
    expect(getSetting("tradeAiReviews:trade_1")).toBe(corruptedRaw);
  });

  it("listAllTradeAiReviews strictly fails on corrupted history during backup without raw export and preserves DB unchanged", async () => {
    const corruptedRaw = "broken raw content that is not valid JSON";
    setSetting("tradeAiReviews:corrupted_trade", corruptedRaw);

    // listAllTradeAiReviews must throw an explicit error (not outputting raw payload in error)
    expect(() => listAllTradeAiReviews()).toThrow(/invalid JSON/i);

    // GET /api/export must fail with 500 without leaking raw payload
    const res = await get(exportGet, "http://localhost/api/export?format=json");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBeDefined();
    expect(JSON.stringify(body)).not.toContain("broken raw content");

    // The database value remains completely unchanged
    expect(getSetting("tradeAiReviews:corrupted_trade")).toBe(corruptedRaw);
  });
});

describe("Intentional Production Deletions and Account Transfers", () => {
  it("DELETE /api/trades/[key] removes trade and cleans up its AI review history", async () => {
    appendTradeAiReview("trade_1", {
      content: "Critique for trade to be deleted",
      provider: "openai",
      model: "gpt-4.1-mini",
    });
    expect(listTradeAiReviews("trade_1")).toHaveLength(1);

    const res = await tradeDelete(
      new Request("http://localhost/api/trades/trade_1", { method: "DELETE" }),
      { params: Promise.resolve({ key: "trade_1" }) },
    );
    expect(res.status).toBe(200);

    // AI reviews for trade_1 must be cleaned up from settings
    expect(listTradeAiReviews("trade_1")).toHaveLength(0);
    expect(getSetting("tradeAiReviews:trade_1")).toBeNull();
  });

  it("POST /api/trades/bulk delete cleans up AI reviews for deleted trades", async () => {
    appendTradeAiReview("trade_1", {
      content: "Review 1",
      provider: "openai",
      model: "gpt-4.1-mini",
    });
    appendTradeAiReview("trade_2", {
      content: "Review 2",
      provider: "openai",
      model: "gpt-4.1-mini",
    });
    expect(listTradeAiReviews("trade_1")).toHaveLength(1);
    expect(listTradeAiReviews("trade_2")).toHaveLength(1);

    const res = await bulkTradesPost(
      new Request("http://localhost/api/trades/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keys: ["trade_1", "trade_2"], action: "delete" }),
      }),
    );
    expect(res.status).toBe(200);

    // Both reviews cleaned up
    expect(listTradeAiReviews("trade_1")).toHaveLength(0);
    expect(listTradeAiReviews("trade_2")).toHaveLength(0);
    expect(getSetting("tradeAiReviews:trade_1")).toBeNull();
    expect(getSetting("tradeAiReviews:trade_2")).toBeNull();
  });

  it("DELETE /api/accounts/[id] cleans up AI review history for all account trades", async () => {
    appendTradeAiReview("trade_1", {
      content: "Review on acc_1 trade 1",
      provider: "openai",
      model: "gpt-4.1-mini",
    });
    appendTradeAiReview("trade_2", {
      content: "Review on acc_1 trade 2",
      provider: "openai",
      model: "gpt-4.1-mini",
    });

    const res = await accountDelete(
      new Request("http://localhost/api/accounts/acc_1", { method: "DELETE" }),
      { params: Promise.resolve({ id: "acc_1" }) },
    );
    expect(res.status).toBe(200);

    expect(listTradeAiReviews("trade_1")).toHaveLength(0);
    expect(listTradeAiReviews("trade_2")).toHaveLength(0);
    expect(getSetting("tradeAiReviews:trade_1")).toBeNull();
    expect(getSetting("tradeAiReviews:trade_2")).toBeNull();
  });

  it("POST /api/accounts/[id]/actions clear cleans up AI review history for all account trades", async () => {
    appendTradeAiReview("trade_1", {
      content: "Review on acc_1 trade 1 to be cleared",
      provider: "openai",
      model: "gpt-4.1-mini",
    });

    const res = await accountActionsPost(
      new Request("http://localhost/api/accounts/acc_1/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "clear" }),
      }),
      { params: Promise.resolve({ id: "acc_1" }) },
    );
    expect(res.status).toBe(200);

    expect(listTradeAiReviews("trade_1")).toHaveLength(0);
    expect(getSetting("tradeAiReviews:trade_1")).toBeNull();
  });

  it("POST /api/accounts/[id]/actions transfer migrates history to new trade keys with no orphans", async () => {
    // 1. Create destination account
    db.insert(accounts)
      .values({
        id: "acc_dest",
        name: "Destination Account",
        currency: "USD",
        kind: "manual",
        createdAt: "2026-01-01T00:00:00.000Z",
      })
      .run();

    // 2. Add review to trade_1 on acc_1
    appendTradeAiReview("trade_1", {
      content: "Critique on source trade before transfer",
      provider: "openai",
      model: "gpt-4.1-mini",
      createdAt: "2026-11-06T10:00:00.000Z",
    });

    // 3. Transfer from acc_1 to acc_dest
    const res = await accountActionsPost(
      new Request("http://localhost/api/accounts/acc_1/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "transfer", toAccountId: "acc_dest" }),
      }),
      { params: Promise.resolve({ id: "acc_1" }) },
    );
    expect(res.status).toBe(200);

    // Old source key review must be deleted
    expect(getSetting("tradeAiReviews:trade_1")).toBeNull();
    expect(listTradeAiReviews("trade_1")).toHaveLength(0);

    // New destination key is: destinationId + source.key.slice(id.length)
    // "acc_dest" + "trade_1".slice("acc_1".length) = "acc_dest" + "_1" = "acc_dest_1"
    const newKey = "acc_dest" + "trade_1".slice("acc_1".length);
    const transferredReviews = listTradeAiReviews(newKey);
    expect(transferredReviews).toHaveLength(1);
    expect(transferredReviews[0]!.content).toBe("Critique on source trade before transfer");

    // Full export contains NO orphan records under old key
    const exportRes = await get(exportGet, "http://localhost/api/export?format=json");
    const exportJson = await exportRes.json();
    const sourceReviewsInExport = exportJson.aiReviews.filter(
      (r: { tradeKey: string }) => r.tradeKey === "trade_1",
    );
    expect(sourceReviewsInExport).toHaveLength(0);

    const destReviewsInExport = exportJson.aiReviews.filter(
      (r: { tradeKey: string }) => r.tradeKey === newKey,
    );
    expect(destReviewsInExport).toHaveLength(1);
  });

  it("deferred provider completion after trade deletion fails with 404 and prevents orphan history resurrection", async () => {
    let fetchCalledResolve: () => void = () => {};
    const fetchCalled = new Promise<void>((r) => {
      fetchCalledResolve = r;
    });

    let resolveProvider: (value: unknown) => void = () => {};
    const pendingProvider = new Promise((resolve) => {
      resolveProvider = resolve;
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        fetchCalledResolve();
        return pendingProvider;
      }),
    );

    // 1. Start confirmed generation while trade_1 exists
    const postPromise = post(critiquePost, { key: "trade_1" });

    // 2. Wait until provider call (fetch) is actively in-flight
    await fetchCalled;

    // 3. Deliberately delete trade_1 while provider await is in flight
    const deleteRes = await tradeDelete(
      new Request("http://localhost/api/trades/trade_1", { method: "DELETE" }),
      { params: Promise.resolve({ key: "trade_1" }) },
    );
    expect(deleteRes.status).toBe(200);

    // 4. Resolve provider response after trade deletion
    resolveProvider(
      Response.json({
        id: "resp_fixture",
        created_at: Math.floor(Date.now() / 1000),
        model: "gpt-4.1-mini",
        status: "completed",
        output: [
          {
            type: "message",
            id: "msg_fixture",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "Critique generated after trade was already deleted",
                annotations: [],
              },
            ],
          },
        ],
        usage: { input_tokens: 15, output_tokens: 10, total_tokens: 25 },
      }),
    );

    // 5. POST route must fail with 404
    const postRes = await postPromise;
    expect(postRes.status).toBe(404);
    const postBody = await postRes.json();
    expect(postBody.error).toMatch(/trade not found/i);

    // 6. Assert NO orphan history was resurrected in settings
    expect(listTradeAiReviews("trade_1")).toHaveLength(0);
    expect(getSetting("tradeAiReviews:trade_1")).toBeNull();

    // 7. Assert listAllTradeAiReviews() and GET /api/export have NO orphan records
    const allReviews = listAllTradeAiReviews();
    expect(allReviews.find((r) => r.tradeKey === "trade_1")).toBeUndefined();

    const exportRes = await get(exportGet, "http://localhost/api/export?format=json");
    const exportJson = await exportRes.json();
    expect(
      exportJson.aiReviews.find((r: { tradeKey: string }) => r.tradeKey === "trade_1"),
    ).toBeUndefined();
  });
});
