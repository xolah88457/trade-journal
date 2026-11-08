"use client";

import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { MonetaryField } from "@/components/privacy";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { VoiceNote } from "@/components/voice-note";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getLocalNowString } from "@/lib/date-input";
import { postJson } from "@/lib/use-api";
import { AccountPicker } from "./account-picker";

type TradeOutcome = "open" | "sl_hit" | "tp_hit" | "break_even";

interface ManualTradeEntryProps {
  onSaved?: (tradeKey?: string) => void;
}

export function ManualTradeEntry({ onSaved }: ManualTradeEntryProps) {
  const router = useRouter();
  const fieldId = useId();

  const [accountId, setAccountId] = useState("");
  const [symbol, setSymbol] = useState("");
  const [direction, setDirection] = useState<"buy" | "sell">("buy"); // Entry direction

  // Entry Section
  const [entryDatetime, setEntryDatetime] = useState(getLocalNowString(16));
  const [quantity, setQuantity] = useState("1");
  const [entryPrice, setEntryPrice] = useState("");
  const [entryFee, setEntryFee] = useState("0");

  // Planned SL & TP
  const [stopLoss, setStopLoss] = useState("");
  const [profitTarget, setProfitTarget] = useState("");

  // Outcome
  const [outcome, setOutcome] = useState<TradeOutcome>("open");
  const [exitDatetime, setExitDatetime] = useState(getLocalNowString(16));
  const [exitFee, setExitFee] = useState("0");

  const [notes, setNotes] = useState("");
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [successNotice, setSuccessNotice] = useState<{ tradeKey?: string; message: string } | null>(
    null,
  );

  // Derived coupled exit side
  const exitSide: "buy" | "sell" = direction === "buy" ? "sell" : "buy";

  // Validate form fields for actionable feedback
  const getValidationErrors = (): string[] => {
    const errors: string[] = [];
    if (!accountId) errors.push("Please select an account.");
    if (!symbol.trim()) errors.push("Please enter a symbol.");
    if (!entryDatetime) errors.push("Please enter an entry date & time.");
    const qty = Number(quantity);
    if (!quantity || !Number.isFinite(qty) || qty <= 0)
      errors.push("Quantity must be greater than 0.");
    const price = Number(entryPrice);
    if (!entryPrice || !Number.isFinite(price) || price <= 0)
      errors.push("Entry price must be greater than 0.");
    const fee = entryFee === "" ? 0 : Number(entryFee);
    if (!Number.isFinite(fee) || fee < 0) errors.push("Entry fee must be 0 or a positive number.");

    // Validate plan values if supplied
    if (stopLoss !== "") {
      const sl = Number(stopLoss);
      if (!Number.isFinite(sl) || sl <= 0) {
        errors.push("Stop loss must be a positive number.");
      } else if (entryPrice && Number.isFinite(price)) {
        if (direction === "buy" && sl >= price) {
          errors.push(`Stop loss (${sl}) must be below entry price (${price}) for a Buy.`);
        } else if (direction === "sell" && sl <= price) {
          errors.push(`Stop loss (${sl}) must be above entry price (${price}) for a Sell.`);
        }
      }
    }

    if (profitTarget !== "") {
      const tp = Number(profitTarget);
      if (!Number.isFinite(tp) || tp <= 0) {
        errors.push("Take profit must be a positive number.");
      } else if (entryPrice && Number.isFinite(price)) {
        if (direction === "buy" && tp <= price) {
          errors.push(`Take profit (${tp}) must be above entry price (${price}) for a Buy.`);
        } else if (direction === "sell" && tp >= price) {
          errors.push(`Take profit (${tp}) must be below entry price (${price}) for a Sell.`);
        }
      }
    }

    // Closed outcome validations
    if (outcome !== "open") {
      if (!exitDatetime) errors.push("Exit date & time is required for closed trades.");
      if (entryDatetime && exitDatetime && Date.parse(exitDatetime) < Date.parse(entryDatetime)) {
        errors.push("Exit date & time must be on or after entry date & time.");
      }
      const exFee = exitFee === "" ? 0 : Number(exitFee);
      if (!Number.isFinite(exFee) || exFee < 0)
        errors.push("Exit fee must be 0 or a positive number.");

      if (outcome === "sl_hit" && (!stopLoss || !Number.isFinite(Number(stopLoss)))) {
        errors.push("Please provide a Stop loss price to record Stop loss hit.");
      }
      if (outcome === "tp_hit" && (!profitTarget || !Number.isFinite(Number(profitTarget)))) {
        errors.push("Please provide a Take profit price to record Take profit hit.");
      }
    }

    return errors;
  };

  const save = async () => {
    if (busy) return;
    setErrorMessage("");
    setSuccessNotice(null);

    const validationErrors = getValidationErrors();
    if (validationErrors.length > 0) {
      setErrorMessage(validationErrors[0]!);
      return;
    }

    setBusy(true);

    try {
      const cleanSymbol = symbol.trim().toUpperCase();
      const numQty = Number(quantity);
      const numEntryPrice = Number(entryPrice);
      const numEntryFee = entryFee === "" ? 0 : Number(entryFee);
      const entryIso = new Date(entryDatetime).toISOString();

      const executionsPayload = [
        {
          symbol: cleanSymbol,
          side: direction,
          quantity: numQty,
          price: numEntryPrice,
          fee: numEntryFee,
          executedAt: entryIso,
        },
      ];

      // If closed, add exactly one opposing fill
      if (outcome !== "open") {
        let closePrice = numEntryPrice; // default for break_even
        if (outcome === "sl_hit") {
          closePrice = Number(stopLoss);
        } else if (outcome === "tp_hit") {
          closePrice = Number(profitTarget);
        }

        const numExitFee = exitFee === "" ? 0 : Number(exitFee);
        const exitIso = new Date(exitDatetime).toISOString();

        executionsPayload.push({
          symbol: cleanSymbol,
          side: exitSide,
          quantity: numQty,
          price: closePrice,
          fee: numExitFee,
          executedAt: exitIso,
        });
      }

      const slValue = stopLoss !== "" ? Number(stopLoss) : null;
      const tpValue = profitTarget !== "" ? Number(profitTarget) : null;

      const response = await postJson<{
        inserted: number;
        duplicates: number;
        tradeKeys?: string[];
      }>("/api/executions", {
        accountId,
        manualTrade: true,
        executions: executionsPayload,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        stopLoss: slValue,
        profitTarget: tpValue,
      });

      const savedTradeKey = response.tradeKeys?.[0];

      if (response.inserted === 0 && response.duplicates > 0) {
        setSuccessNotice({
          tradeKey: savedTradeKey,
          message: "Execution(s) already existed in journal (duplicates ignored).",
        });
      } else {
        setSuccessNotice({
          tradeKey: savedTradeKey,
          message: savedTradeKey
            ? "Trade saved successfully!"
            : "Trade executions saved successfully!",
        });
      }

      if (onSaved) {
        onSaved(savedTradeKey);
      }
    } catch (cause) {
      setErrorMessage(
        cause instanceof Error ? cause.message : "Couldn’t save the trade. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <fieldset disabled={busy} className="min-w-0 space-y-4">
      {/* Account & Symbol */}
      <div className="grid gap-3 sm:grid-cols-2">
        <AccountPicker value={accountId} onChange={setAccountId} kind="manual" />
        <div>
          <Label htmlFor={`${fieldId}-symbol`} className="mb-1 block text-xs text-muted-foreground">
            Symbol
          </Label>
          <Input
            id={`${fieldId}-symbol`}
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            placeholder="Arbitrary symbol (AAPL, ES, BTCUSDT, EURUSD…)"
          />
        </div>
      </div>

      {/* 1. ENTRY SECTION */}
      <fieldset className="grid min-w-0 gap-3 rounded-lg border p-3">
        <legend className="px-1 text-xs font-semibold text-foreground">Entry</legend>
        <div className="grid min-w-0 gap-2 sm:grid-cols-2 md:grid-cols-5">
          <label className="grid min-w-0 gap-1 text-xs text-muted-foreground">
            Date & time
            <Input
              type="datetime-local"
              value={entryDatetime}
              onChange={(e) => setEntryDatetime(e.target.value)}
            />
          </label>
          <div className="grid min-w-0 gap-1 text-xs text-muted-foreground">
            <span id={`${fieldId}-entry-side`}>Side</span>
            <Select value={direction} onValueChange={(val) => setDirection(val as "buy" | "sell")}>
              <SelectTrigger aria-labelledby={`${fieldId}-entry-side`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="buy">Buy (Long)</SelectItem>
                <SelectItem value="sell">Sell (Short)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <label className="grid min-w-0 gap-1 text-xs text-muted-foreground">
            Quantity
            <Input
              placeholder="1"
              inputMode="decimal"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </label>
          <label className="grid min-w-0 gap-1 text-xs text-muted-foreground">
            Entry Price
            <MonetaryField>
              <Input
                placeholder="price"
                inputMode="decimal"
                value={entryPrice}
                onChange={(e) => setEntryPrice(e.target.value)}
              />
            </MonetaryField>
          </label>
          <label className="grid min-w-0 gap-1 text-xs text-muted-foreground">
            Fee
            <MonetaryField>
              <Input
                placeholder="0"
                inputMode="decimal"
                value={entryFee}
                onChange={(e) => setEntryFee(e.target.value)}
              />
            </MonetaryField>
          </label>
        </div>
      </fieldset>

      {/* 2. STOP LOSS SECTION */}
      <fieldset
        className={`grid min-w-0 gap-3 rounded-lg border p-3 transition-opacity ${
          outcome === "tp_hit" ? "opacity-50" : ""
        }`}
      >
        <div className="flex items-center justify-between">
          <legend className="px-1 text-xs font-semibold text-foreground">
            Stop loss (Planned level)
          </legend>
          <span className="text-xs text-muted-foreground">
            Target side: <span className="font-medium uppercase">{exitSide}</span>
          </span>
        </div>
        <div className="grid min-w-0 gap-2 sm:grid-cols-2">
          <label className="grid min-w-0 gap-1 text-xs text-muted-foreground">
            Stop loss price
            <MonetaryField>
              <Input
                placeholder="Optional SL price"
                inputMode="decimal"
                value={stopLoss}
                onChange={(e) => setStopLoss(e.target.value)}
              />
            </MonetaryField>
          </label>
          <p className="flex items-center text-xs text-muted-foreground">
            Used for planned risk calculation. Never executed unless &ldquo;Stop loss hit&rdquo; is
            selected.
          </p>
        </div>
      </fieldset>

      {/* 3. TAKE PROFIT SECTION */}
      <fieldset
        className={`grid min-w-0 gap-3 rounded-lg border p-3 transition-opacity ${
          outcome === "sl_hit" ? "opacity-50" : ""
        }`}
      >
        <div className="flex items-center justify-between">
          <legend className="px-1 text-xs font-semibold text-foreground">
            Take profit (Planned level)
          </legend>
          <span className="text-xs text-muted-foreground">
            Target side: <span className="font-medium uppercase">{exitSide}</span>
          </span>
        </div>
        <div className="grid min-w-0 gap-2 sm:grid-cols-2">
          <label className="grid min-w-0 gap-1 text-xs text-muted-foreground">
            Take profit price
            <MonetaryField>
              <Input
                placeholder="Optional TP price"
                inputMode="decimal"
                value={profitTarget}
                onChange={(e) => setProfitTarget(e.target.value)}
              />
            </MonetaryField>
          </label>
          <p className="flex items-center text-xs text-muted-foreground">
            Used for planned R:R reward calculation. Never executed unless &ldquo;Take profit
            hit&rdquo; is selected.
          </p>
        </div>
      </fieldset>

      {/* OUTCOME SELECTOR */}
      <fieldset className="grid min-w-0 gap-3 rounded-lg border bg-muted/20 p-3">
        <legend className="px-1 text-xs font-semibold text-foreground">Trade Outcome</legend>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant={outcome === "open" ? "default" : "outline"}
            onClick={() => setOutcome("open")}
          >
            Open
          </Button>
          <Button
            type="button"
            size="sm"
            variant={outcome === "sl_hit" ? "destructive" : "outline"}
            onClick={() => setOutcome("sl_hit")}
          >
            Stop loss hit
          </Button>
          <Button
            type="button"
            size="sm"
            variant={outcome === "tp_hit" ? "default" : "outline"}
            onClick={() => setOutcome("tp_hit")}
          >
            Take profit hit
          </Button>
          <Button
            type="button"
            size="sm"
            variant={outcome === "break_even" ? "secondary" : "outline"}
            onClick={() => setOutcome("break_even")}
          >
            Break even before fees
          </Button>
        </div>

        {outcome !== "open" && (
          <div className="grid min-w-0 gap-2 pt-2 sm:grid-cols-3">
            <label className="grid min-w-0 gap-1 text-xs text-muted-foreground">
              Exit date & time
              <Input
                type="datetime-local"
                value={exitDatetime}
                onChange={(e) => setExitDatetime(e.target.value)}
              />
            </label>
            <label className="grid min-w-0 gap-1 text-xs text-muted-foreground">
              Exit Fee
              <MonetaryField>
                <Input
                  placeholder="0"
                  inputMode="decimal"
                  value={exitFee}
                  onChange={(e) => setExitFee(e.target.value)}
                />
              </MonetaryField>
            </label>
            <div className="flex flex-col justify-end text-xs text-muted-foreground">
              <span>
                Exit fill: <strong className="uppercase">{exitSide}</strong> {quantity || 1} @{" "}
                <strong>
                  {outcome === "sl_hit"
                    ? stopLoss || "SL price"
                    : outcome === "tp_hit"
                      ? profitTarget || "TP price"
                      : entryPrice || "Entry price"}
                </strong>
              </span>
              {outcome === "break_even" && (
                <span className="text-[11px] text-muted-foreground">
                  (Gross P&L: 0.00, fees deducted normally)
                </span>
              )}
            </div>
          </div>
        )}
      </fieldset>

      {/* NOTES */}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <Label htmlFor={`${fieldId}-notes`}>Notes (optional)</Label>
          <VoiceNote targetRef={notesRef} onText={(val) => setNotes(val)} />
        </div>
        <textarea
          ref={notesRef}
          id={`${fieldId}-notes`}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          maxLength={100000}
          rows={3}
          placeholder="Your setup, trade context, or review notes…"
          className="flex w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
        />
      </div>

      {/* FEEDBACK & ACTIONS */}
      {errorMessage && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {errorMessage}
        </p>
      )}

      {successNotice && (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted p-2 text-sm text-foreground">
          <span>{successNotice.message}</span>
          {successNotice.tradeKey && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => router.push(`/trades/${encodeURIComponent(successNotice.tradeKey!)}`)}
            >
              View trade &rarr;
            </Button>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save trade"}
        </Button>
      </div>
    </fieldset>
  );
}
