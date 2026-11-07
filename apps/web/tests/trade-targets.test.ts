import { describe, expect, it } from "vitest";
import { hitTradeTarget } from "../src/lib/trade-targets";

describe("hitTradeTarget", () => {
  it("detects profit target with low-priced crypto values", () => {
    expect(hitTradeTarget("win", 3e-8, 1e-8, 3e-8)).toBe("profit_target");
  });

  it("returns null for break-even at entry between plans", () => {
    expect(hitTradeTarget("closed", 2e-8, 1e-8, 3e-8)).toBeNull();
  });

  it("returns null when status is open or prices missing", () => {
    expect(hitTradeTarget("open", 3e-8, 1e-8, 3e-8)).toBeNull();
    expect(hitTradeTarget("closed", null, 1e-8, 3e-8)).toBeNull();
    expect(hitTradeTarget("closed", 3e-8, null, null)).toBeNull();
  });

  it("detects ordinary stop loss and roundoff near profit target", () => {
    expect(hitTradeTarget("loss", 100, 100, 150)).toBe("stop_loss");
    const nearTp = 150 + Number.EPSILON * 150;
    expect(hitTradeTarget("win", nearTp, 100, 150)).toBe("profit_target");
  });

  it("resolves ambiguous tie to null when both targets are equidistant within roundoff", () => {
    expect(hitTradeTarget("closed", 100, 100, 100)).toBeNull();
  });
});
