"use client";

import { useState } from "react";
import { MonetaryField } from "@/components/privacy";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getLocalNowString } from "@/lib/date-input";
import { postJson } from "@/lib/use-api";
import { fmtMoney } from "@/lib/utils";

interface TradeOutcomeControlsProps {
  trade: {
    key: string;
    accountId: string;
    symbol: string;
    direction: "long" | "short";
    status: string;
    openQuantity: number;
    avgEntry: number;
    openedAt: string;
    stopLoss?: number | null;
    profitTarget?: number | null;
  };
  onClosed?: () => void;
}

/**
 * Dedicated controls to close an existing open trade by selecting which target hit,
 * breaking even before fees, or entering a custom exit price.
 */
export function TradeOutcomeControls({ trade, onClosed }: TradeOutcomeControlsProps) {
  const [outcome, setOutcome] = useState<"sl_hit" | "tp_hit" | "break_even" | "custom">("sl_hit");
  const [customPrice, setCustomPrice] = useState("");
  const [exitDatetime, setExitDatetime] = useState(getLocalNowString(19));
  const [fee, setFee] = useState("0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (trade.status !== "open" || trade.openQuantity <= 0) {
    return null;
  }

  const exitSide = trade.direction === "long" ? "SELL" : "BUY";

  const closeTrade = async () => {
    if (busy) return;
    setError("");

    if (!exitDatetime) {
      setError("Please select an exit date and time.");
      return;
    }
    if (Date.parse(exitDatetime) < Date.parse(trade.openedAt)) {
      setError("Exit date & time must be on or after entry date & time.");
      return;
    }

    let payloadOutcome: "stop_loss" | "profit_target" | "break_even" | "custom" = "custom";
    let price: number | undefined;

    if (outcome === "sl_hit") {
      if (trade.stopLoss == null) {
        setError("This trade does not have a planned Stop loss level set.");
        return;
      }
      payloadOutcome = "stop_loss";
    } else if (outcome === "tp_hit") {
      if (trade.profitTarget == null) {
        setError("This trade does not have a planned Take profit level set.");
        return;
      }
      payloadOutcome = "profit_target";
    } else if (outcome === "break_even") {
      payloadOutcome = "break_even";
    } else {
      const p = Number(customPrice);
      if (!customPrice || !Number.isFinite(p) || p <= 0) {
        setError("Please enter a valid positive exit price.");
        return;
      }
      price = p;
    }

    setBusy(true);
    try {
      await postJson(`/api/trades/${encodeURIComponent(trade.key)}/close`, {
        outcome: payloadOutcome,
        price,
        fee: fee === "" ? 0 : Number(fee),
        executedAt: new Date(exitDatetime).toISOString(),
      });
      if (onClosed) onClosed();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn’t close trade.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-foreground">Close open position</h4>
        <span className="text-xs text-muted-foreground">
          Open: <strong>{trade.openQuantity}</strong> ({trade.direction.toUpperCase()})
        </span>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant={outcome === "sl_hit" ? "destructive" : "outline"}
          disabled={trade.stopLoss == null}
          onClick={() => setOutcome("sl_hit")}
          title={trade.stopLoss != null ? `SL @ ${trade.stopLoss}` : "No planned SL set"}
        >
          SL hit {trade.stopLoss != null ? `(${trade.stopLoss})` : ""}
        </Button>
        <Button
          type="button"
          size="sm"
          variant={outcome === "tp_hit" ? "default" : "outline"}
          disabled={trade.profitTarget == null}
          onClick={() => setOutcome("tp_hit")}
          title={trade.profitTarget != null ? `TP @ ${trade.profitTarget}` : "No planned TP set"}
        >
          TP hit {trade.profitTarget != null ? `(${trade.profitTarget})` : ""}
        </Button>
        <Button
          type="button"
          size="sm"
          variant={outcome === "break_even" ? "secondary" : "outline"}
          onClick={() => setOutcome("break_even")}
          title="Exit at entry price (gross P&L 0)"
        >
          Break even before fees ({fmtMoney(trade.avgEntry)})
        </Button>
        <Button
          type="button"
          size="sm"
          variant={outcome === "custom" ? "secondary" : "outline"}
          onClick={() => setOutcome("custom")}
        >
          Custom price
        </Button>
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        {outcome === "custom" && (
          <label className="grid gap-1 text-xs text-muted-foreground">
            Exit Price
            <MonetaryField>
              <Input
                placeholder="Exit price"
                inputMode="decimal"
                value={customPrice}
                onChange={(e) => setCustomPrice(e.target.value)}
              />
            </MonetaryField>
          </label>
        )}
        <label className="grid gap-1 text-xs text-muted-foreground">
          Exit Date & Time
          <Input
            type="datetime-local"
            step={1}
            value={exitDatetime}
            onChange={(e) => setExitDatetime(e.target.value)}
          />
        </label>
        <label className="grid gap-1 text-xs text-muted-foreground">
          Exit Fee
          <MonetaryField>
            <Input
              placeholder="0"
              inputMode="decimal"
              value={fee}
              onChange={(e) => setFee(e.target.value)}
            />
          </MonetaryField>
        </label>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        <span className="text-xs text-muted-foreground">
          Will record {exitSide} {trade.openQuantity} fill.
        </span>
        <Button type="button" size="sm" onClick={closeTrade} disabled={busy}>
          {busy ? "Recording exit…" : "Confirm exit"}
        </Button>
      </div>

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
