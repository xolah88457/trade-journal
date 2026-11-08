import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCsv, parseCsvHeader } from "../src/csv";
import { detectFormat } from "../src/detect";

const file = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const TRADERVUE = `Date,Time,Symbol,Quantity,Price,Side,Commission,TransFee,ECNFee
2026-01-05,09:31:00,AAPL,100,185.50,Buy,1.00,0.10,0.25
2026-01-05,10:15:00,AAPL,100,187.25,Sell,1.00,0.10,0.25`;
const TRADEZELLA = `Open Date,Close Date,Symbol,Side,Volume,Entry Price,Exit Price,Net P&L,Commissions
2026-01-05 09:31:00,2026-01-05 10:15:00,AAPL,LONG,100,185.50,187.25,171.00,4.00`;
const NINJA = `Instrument,Action,Quantity,Price,Time,Commission
ES 03-26,Buy,2,5000.25,2026-01-05 09:31:05,4.10
ES 03-26,Sell,2,5010.50,2026-01-05 09:45:10,4.10`;
const IBKR = `Trades,Header,DataDiscriminator,Asset Category,Currency,Symbol,Date/Time,Quantity,T. Price,C. Price,Proceeds,Comm/Fee,Basis,Realized P/L,MTM P/L,Code
Trades,Data,Order,Stocks,USD,AAPL,"2026-01-05, 09:31:00",100,185.50,187.0,-18550,-1.00,18551,0,150,O`;
const DAS = "Symb,B/S,Price,Time,Date,Qty\nAAPL,B,100,09:00,2026-01-05,1";
const TOS =
  "Account Trade History\nExec Time,Symbol,Side,Qty,Price\n2026-01-05 09:00,AAPL,BUY,1,100\n\nAccount Summary";
const MT4 = `<html><body><div>MetaTrader 4 - Closed Transactions:</div><table>
<tr><td>Ticket</td><td>Open Time</td><td>Type</td><td>Size</td><td>Item</td><td>Price</td><td>S / L</td><td>T / P</td><td>Close Time</td><td>Price</td><td>Commission</td><td>Taxes</td><td>Swap</td><td>Profit</td></tr>
<tr><td>1</td><td>2026.01.05 09:31</td><td>buy</td><td>1.00</td><td>eurusd</td><td>1.09500</td><td>0</td><td>0</td><td>2026.01.05 14:20</td><td>1.09850</td><td>-7.00</td><td>0.00</td><td>-0.50</td><td>350.00</td></tr></table></body></html>`;
const GENERIC = "When,Ticker,Way,Amount,Cost\n2026-01-05 09:31:00,AAPL,bought,100,185.50";
// Header split across a quoted field with an embedded newline and CRLF endings.
const QUOTED_HEADER =
  '"Open\nDate",Close Date,Symbol,Side,Volume,Entry Price,Exit Price,Net P&L,Commissions\r\n2026-01-05 09:31:00,2026-01-05 10:15:00,AAPL,LONG,100,185.50,187.25,171.00,4.00\r\n';

/** Every input detection is exercised against: fixtures, samples and header edge cases. */
const CORPUS: Record<string, string> = {
  "fixture:hyperliquid": file("./fixtures/hyperliquid-trade-history.csv"),
  "fixture:ninjatrader": file("./fixtures/ninjatrader-copy-trades.csv"),
  "sample:tradingview": file("../../../docs/samples/demo-trades-tradingview.csv"),
  "sample:mt5-html": file("../../../docs/samples/mt5-timezone.html"),
  tradervue: TRADERVUE,
  tradezella: TRADEZELLA,
  ninjatrader: NINJA,
  ibkr: IBKR,
  das: DAS,
  thinkorswim: TOS,
  mt4: MT4,
  generic: GENERIC,
  "tradezella+bom": `﻿${TRADEZELLA}`,
  "tradezella+crlf": TRADEZELLA.replace(/\n/g, "\r\n"),
  "tradezella+cr": TRADEZELLA.replace(/\n/g, "\r"),
  "tradezella+semicolon": TRADEZELLA.replace(/,/g, ";"),
  "tradervue+leading-blank-lines": `\n\r\n${TRADERVUE}`,
  "quoted-header-newline": QUOTED_HEADER,
  "header-only": "Instrument,Action,Quantity,Price,Time,Commission",
  "ibkr+bom+crlf": `﻿${IBKR.replace(/\n/g, "\r\n")}`,
  empty: "",
  whitespace: "  \n\n",
};

// Recorded by running the original implementation (full-file parseCsv for the header).
const EXPECTED: Record<string, string | null> = {
  "fixture:hyperliquid": "hyperliquid",
  "fixture:ninjatrader": "ninjatrader",
  "sample:tradingview": "tradingview",
  "sample:mt5-html": "trade-history",
  tradervue: "tradervue",
  tradezella: "tradezella",
  ninjatrader: "ninjatrader",
  ibkr: "ibkr",
  das: "das-trader",
  thinkorswim: "thinkorswim",
  mt4: "metatrader",
  generic: null,
  "tradezella+bom": "tradezella",
  "tradezella+crlf": "tradezella",
  "tradezella+cr": "tradezella",
  "tradezella+semicolon": "tradezella",
  "tradervue+leading-blank-lines": "tradervue",
  "quoted-header-newline": "tradezella",
  "header-only": "ninjatrader",
  "ibkr+bom+crlf": "ibkr",
  empty: null,
  whitespace: null,
};

describe("format detection over every fixture and sample", () => {
  it("matches the results recorded from the full-file implementation", () => {
    const actual = Object.fromEntries(
      Object.entries(CORPUS).map(([name, content]) => [name, detectFormat(content)?.id ?? null]),
    );
    if (process.env.PRINT_DETECT) console.log(JSON.stringify(actual, null, 2));
    expect(actual).toEqual(EXPECTED);
  });

  it("reads the header without parsing the rest, identically to a full parse", () => {
    for (const [name, content] of Object.entries(CORPUS)) {
      expect(parseCsvHeader(content), name).toEqual(parseCsv(content)[0] ?? []);
    }
  });
});
