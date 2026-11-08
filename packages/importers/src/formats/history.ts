import { importTradeHistory } from "../history/import";
import type { ImportResult } from "../history/model";
import type { ImportFormat, ImportOptions, ImportedExecution, ParsedImport } from "../types";

const symbolFrom = (content: string, options: ImportOptions): string | undefined => {
  if (options.symbol?.trim()) return options.symbol.trim().toUpperCase();
  // Only a known exchange + ticker in TradingView's filename counts as evidence.
  const name = options.fileName?.match(
    /(?:^|_)(?:NASDAQ|NYSE|AMEX|CME|COMEX|CBOT|NYMEX|OANDA|FOREXCOM|BINANCE|COINBASE)_([A-Za-z0-9.!-]+)_(?=\d)/i,
  );
  if (name) return name[1]!.toUpperCase();
  const preamble = content
    .slice(0, 4000)
    .match(/^(?:symbol|ticker)\s*[,;\t:]\s*"?([A-Za-z0-9:/.!_-]+)"?\s*$/im);
  return preamble?.[1]?.split(":").pop()?.toUpperCase();
};

/** A history result is usable when a documented signature matched. */
const recognizable = (result: ImportResult): boolean => result.format.kind !== "unknown";

const issueMessages = (result: ImportResult) =>
  result.issues.filter((item) => item.severity === "warning").map((item) => item.message);

export const parseHistory = (content: string, options: ImportOptions = {}): ParsedImport | null => {
  const history = importTradeHistory(content, { timeZone: options.timeZone });
  if (!recognizable(history)) return null;
  const warnings = issueMessages(history);
  const errors = history.issues
    .filter(
      (i) =>
        i.severity === "error" ||
        i.code === "input-truncated" ||
        (i.code === "malformed-csv" && /never closed/.test(i.message)),
    )
    .map((i) => i.message);
  const executions: ImportedExecution[] = [];
  const format = `history-${history.format.kind}`;
  const fallbackSymbol = symbolFrom(content, options);
  let needsSymbol = false;
  let skippedRows = history.stats.skippedRows;
  const occurrences = new Map<string, number>();
  const nextId = (key: string) => {
    const n = occurrences.get(key) ?? 0;
    occurrences.set(key, n + 1);
    return `${key}|${n}`;
  };
  if (history.executions) {
    const positions = new Map<string, number>();
    const seenDeals = new Set<string>();
    let creditNoted = false;
    for (const fill of [...history.executions].sort(
      (a, b) => (a.time ?? 0) - (b.time ?? 0) || a.row - b.row,
    )) {
      const symbol = (fill.symbol || fallbackSymbol)?.trim().toUpperCase();
      if (!symbol) needsSymbol = true;
      if (
        !symbol ||
        fill.time === null ||
        !Number.isFinite(fill.time) ||
        !(fill.quantity > 0) ||
        !Number.isFinite(fill.quantity) ||
        !Number.isFinite(fill.price)
      ) {
        skippedRows++;
        continue;
      }
      const executedAt = new Date(fill.time).toISOString();
      const tuple = JSON.stringify([symbol, fill.side, fill.quantity, fill.price, executedAt]);
      const id = fill.id ? `${format}:${fill.id}` : nextId(`${format}:${tuple}`);
      if (fill.effect) {
        const dealKey = `${id}|${tuple}`;
        if (seenDeals.has(dealKey)) continue;
        seenDeals.add(dealKey);
        const position = positions.get(symbol) ?? 0;
        const signed = fill.side === "buy" ? fill.quantity : -fill.quantity;
        const opposite = position !== 0 && Math.sign(position) !== Math.sign(signed);
        if (
          (fill.effect === "in" && opposite) ||
          (fill.effect === "out" && (!opposite || Math.abs(signed) > Math.abs(position) + 1e-9)) ||
          (fill.effect === "in/out" && (!opposite || Math.abs(signed) <= Math.abs(position)))
        ) {
          skippedRows++;
          warnings.push(
            `Line ${fill.row}: the deal has no matching position in this file; skipped.`,
          );
          continue;
        }
        const next = position + signed;
        positions.set(symbol, Math.abs(next) < 1e-9 ? 0 : next);
      }
      // Fees are costs and never negative. A net credit (a swap larger than the
      // commission) is folded into the reported gross so the net P&L is unchanged.
      let fee = fill.fees ?? 0;
      let reportedGrossPnl = fill.reportedGrossPnl;
      if (fee < 0) {
        if (reportedGrossPnl !== undefined) reportedGrossPnl += fee;
        else if (!creditNoted) {
          creditNoted = true;
          warnings.push(
            `Line ${fill.row}: a fee credit (negative fee) on a fill without a reported P&L was recorded as a zero fee.`,
          );
        }
        fee = 0;
      }
      executions.push({
        symbol,
        side: fill.side,
        quantity: fill.quantity,
        price: fill.price,
        fee,
        executedAt,
        importMetadata: {
          id,
          order: fill.row,
          preserveFee: fill.fees !== null,
          ...(reportedGrossPnl !== undefined ? { reportedGrossPnl } : {}),
        },
      });
    }
  } else {
    for (const trade of history.trades) {
      const symbol = (trade.symbol || fallbackSymbol)?.trim().toUpperCase();
      if (!symbol) needsSymbol = true;
      if (
        !symbol ||
        !trade.direction ||
        trade.entryTime === null ||
        trade.exitTime === null ||
        !Number.isFinite(trade.entryTime) ||
        !Number.isFinite(trade.exitTime) ||
        trade.exitTime < trade.entryTime ||
        trade.entryPrice === null ||
        trade.exitPrice === null ||
        !Number.isFinite(trade.entryPrice) ||
        !Number.isFinite(trade.exitPrice) ||
        trade.quantity === null ||
        !(trade.quantity > 0) ||
        !Number.isFinite(trade.quantity)
      ) {
        skippedRows += trade.sourceRows.length;
        continue;
      }
      const openedAt = new Date(trade.entryTime).toISOString();
      const closedAt = new Date(trade.exitTime).toISOString();
      const identity = JSON.stringify([
        format,
        trade.id,
        symbol,
        trade.direction,
        openedAt,
        trade.entryPrice,
        ...(trade.id ? [] : [closedAt, trade.exitPrice, trade.quantity]),
      ]);
      const group = identity;
      // Fees are costs: a net credit becomes a zero fee and stays in the P&L.
      const rawFee = trade.fees ?? 0;
      const fee = Math.max(0, rawFee);
      let reportedGrossPnl: number | undefined;
      if (trade.pnlReported && trade.pnl !== null) {
        // Signature adapters report net P&L (net = gross - fee), so the fee is
        // added back; a credit already sits inside the net figure.
        reportedGrossPnl = trade.pnl + fee;
      }
      const preserveFee = trade.fees !== null || reportedGrossPnl !== undefined;
      const side = trade.direction === "long" ? "buy" : "sell";
      executions.push(
        {
          symbol,
          side,
          quantity: trade.quantity,
          price: trade.entryPrice,
          fee: 0,
          executedAt: openedAt,
          importMetadata: { id: "entry", group, order: 0, preserveFee: true },
        },
        {
          symbol,
          side: side === "buy" ? "sell" : "buy",
          quantity: trade.quantity,
          price: trade.exitPrice,
          fee,
          executedAt: closedAt,
          importMetadata: {
            id: "exit",
            group,
            order: 1,
            preserveFee,
            ...(reportedGrossPnl !== undefined ? { reportedGrossPnl } : {}),
          },
        },
      );
    }
    if (history.openTrades.length) {
      skippedRows += history.openTrades.reduce((sum, trade) => sum + trade.sourceRows.length, 0);
      warnings.push(
        `${history.openTrades.length} incomplete position(s) skipped; this history export requires completed entry/exit pairs.`,
      );
    }
  }
  if (needsSymbol) errors.push("Choose the symbol for this file before importing.");
  if (skippedRows > history.stats.skippedRows && !needsSymbol)
    warnings.push(
      "Some history rows lack valid prices, quantity, direction or complete timestamps and were skipped.",
    );
  if (!executions.length && !needsSymbol && !errors.length)
    errors.push("No complete executions could be imported from this history.");
  return {
    format,
    executions: errors.length ? [] : executions,
    skippedRows,
    warnings: [...new Set(warnings)].slice(0, 50),
    ...(errors.length ? { errors: [...new Set(errors)].slice(0, 20) } : {}),
    ...(needsSymbol ? { needsSymbol: true } : {}),
  };
};

export const historyFormat: ImportFormat = {
  id: "trade-history",
  label: "Trade history (TradingView strategy and MetaTrader exports)",
  detect: (_headers, content) => recognizable(importTradeHistory(content)),
  parse: (content, options) =>
    parseHistory(content, options) ?? {
      format: "trade-history",
      executions: [],
      skippedRows: 0,
      warnings: [],
      errors: ["History columns could not be recognized."],
    },
};
