import { describe, expect, it } from "vitest";
import { buildRoundTrips } from "../src/round-trips";
import type { Execution, ProfitCalcMethod } from "../src/types";
import { buildRoundTripsLegacy } from "./round-trips.legacy";

/** Small deterministic PRNG so failures reproduce. */
const rng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};

const SYMBOLS = ["AAPL", "ES", "BTC", "EURUSD"];
const METHODS: ProfitCalcMethod[] = ["fifo", "lifo", "wavg"];

const randomFills = (seed: number, count: number, fractional: boolean): Execution[] => {
  const next = rng(seed);
  const fills: Execution[] = [];
  const base = Date.parse("2026-01-05T09:30:00Z");
  for (let i = 0; i < count; i++) {
    const quantity = fractional
      ? Math.round(next() * 1000) / 1000 + 0.001
      : 1 + Math.floor(next() * 10);
    fills.push({
      id: `e${Math.floor(next() * 1e9)}-${i}`,
      accountId: next() < 0.8 ? "a1" : "a2",
      symbol: SYMBOLS[Math.floor(next() * SYMBOLS.length)]!,
      side: next() < 0.5 ? "buy" : "sell",
      quantity,
      price: Math.round((100 + next() * 20) * 100) / 100,
      fee: Math.round(next() * 300) / 100,
      // Coarse timestamps force ties; the odd unparseable value exercises NaN ordering.
      executedAt:
        next() < 0.01
          ? "not-a-date"
          : new Date(base + Math.floor(next() * 400) * 1000).toISOString(),
      assetClass: next() < 0.5 ? "stock" : undefined,
      source: "import",
      importMetadata:
        next() < 0.3
          ? {
              ...(next() < 0.5 ? { order: Math.floor(next() * 3) } : {}),
              ...(next() < 0.2 ? { group: `g${Math.floor(next() * 2)}` } : {}),
              ...(next() < 0.1 ? { reportedGrossPnl: Math.round(next() * 1000) / 10 } : {}),
            }
          : undefined,
    });
  }
  // Shuffle so input order differs from time order.
  for (let i = fills.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [fills[i], fills[j]] = [fills[j]!, fills[i]!];
  }
  return fills;
};

describe("round-trip building matches the pre-optimization implementation exactly", () => {
  it("is byte-identical on randomized fills for every profit method", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const fills = randomFills(seed, 20 + (seed % 7) * 40, seed % 2 === 0);
      for (const method of METHODS) {
        const options = { method, multipliers: { ES: 50 } };
        expect(JSON.stringify(buildRoundTrips(fills, options))).toBe(
          JSON.stringify(buildRoundTripsLegacy(fills, options)),
        );
      }
    }
  });

  it("is byte-identical on a scale-in/scale-out heavy single symbol", () => {
    const next = rng(99);
    const fills: Execution[] = [];
    for (let i = 0; i < 3000; i++) {
      const buying = Math.floor(i / 300) % 2 === 0;
      fills.push({
        id: `f${i}`,
        accountId: "a",
        symbol: "X",
        side: next() < 0.9 ? (buying ? "buy" : "sell") : buying ? "sell" : "buy",
        quantity: Math.round(next() * 700) / 1000 + 0.1,
        price: 50 + next() * 5,
        fee: 0.01,
        executedAt: new Date(Date.UTC(2026, 0, 5, 9, 0, 0) + i * 1000).toISOString(),
        source: "import",
      });
    }
    for (const method of METHODS) {
      expect(JSON.stringify(buildRoundTrips(fills, { method }))).toBe(
        JSON.stringify(buildRoundTripsLegacy(fills, { method })),
      );
    }
  });

  it("builds 20k fills with thousands of open lots quickly (timings logged against the legacy path)", () => {
    // Long accumulation then a long distribution: thousands of simultaneously open lots.
    const manyFills = (count: number): Execution[] =>
      Array.from({ length: count }, (_, i) => ({
        id: `b${i}`,
        accountId: "a",
        symbol: "X",
        side: i < count / 2 ? ("buy" as const) : ("sell" as const),
        quantity: 1 + (i % 5),
        price: 100 + (i % 17) / 10,
        fee: 0.05,
        executedAt: new Date(Date.UTC(2026, 0, 5, 0, 0, 0) + i * 1000).toISOString(),
        source: "import" as const,
      }));
    const timed = <T>(run: () => T): [T, number] => {
      const start = performance.now();
      const result = run();
      return [result, performance.now() - start];
    };
    // wavg rescales every open lot per exit by definition, so it is measured on a smaller set.
    const cases: [ProfitCalcMethod, number][] = [
      ["fifo", 20_000],
      ["lifo", 20_000],
      ["wavg", 4_000],
    ];
    for (const [method, count] of cases) {
      const fills = manyFills(count);
      const [fast, fastMs] = timed(() => buildRoundTrips(fills, { method }));
      const [legacy, legacyMs] = timed(() => buildRoundTripsLegacy(fills, { method }));
      console.log(
        `${count} fills ${method}: new ${fastMs.toFixed(0)} ms, legacy ${legacyMs.toFixed(0)} ms`,
      );
      expect(JSON.stringify(fast)).toBe(JSON.stringify(legacy));
    }
  }, 120_000);
});
