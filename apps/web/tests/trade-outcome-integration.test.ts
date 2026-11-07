import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { TradeOutcomeControls } from "../src/components/trade-outcome-controls";

describe("TradeOutcomeControls gating & mounting", () => {
  const baseTrade = {
    key: "trade-1",
    accountId: "man1",
    symbol: "BTCUSDT",
    direction: "long" as const,
    status: "open",
    openQuantity: 1.5,
    avgEntry: 50000,
    openedAt: "2026-01-01T10:00:00.000Z",
    stopLoss: 48000,
    profitTarget: 55000,
  };

  it("renders outcome buttons when trade is open with planned targets", () => {
    const html = renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(TradeOutcomeControls, { trade: baseTrade }),
      ),
    );
    expect(html).toContain("Close open position");
    expect(html).toContain("SL hit (48000)");
    expect(html).toContain("TP hit (55000)");
    expect(html).toContain("Break even before fees");
  });

  it("renders nothing when trade is already closed", () => {
    const html = renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(TradeOutcomeControls, {
          trade: { ...baseTrade, status: "win", openQuantity: 0 },
        }),
      ),
    );
    expect(html).toBe("");
  });

  it("renders datetime-local input with step 1 and seconds in default close time", () => {
    const html = renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(TradeOutcomeControls, { trade: baseTrade }),
      ),
    );
    expect(html).toContain('step="1"');
    expect(html).toMatch(/type="datetime-local"[^>]*step="1"/);
    expect(html).toMatch(/value="\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}"/);
  });
});
