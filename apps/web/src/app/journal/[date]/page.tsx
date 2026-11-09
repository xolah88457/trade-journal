"use client";
import { AiRecap } from "@/components/ai-recap";

import Link from "next/link";
import { Trash2 } from "lucide-react";
import { Suspense, use, useRef, useState } from "react";
import type { IntradayPoint, TradeMetrics } from "@luxalgo/journal-core";
import { EquityArea } from "@/components/charts/equity-area";
import { FilterBar, useFilters } from "@/components/filter-bar";
import { Pnl } from "@/components/pnl";
import { MonetaryValue } from "@/components/privacy";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { RichEditor, type RichEditorHandle } from "@/components/rich-editor";
import { Attachments } from "@/components/attachments";
import { DailyReportExport } from "@/components/daily-report-export";
import { useAutosave } from "@/lib/use-autosave";
import { postJson, useApi } from "@/lib/use-api";
import { fmtMoney, fmtNumber, fmtPercent } from "@/lib/utils";

interface TradeRowLite {
  key: string;
  symbol: string;
  direction: string;
  status: string;
  netPnl: number;
  quantity: number;
  avgEntry: number;
  avgExit: number | null;
  fees: number;
}

interface DayPayload {
  date: string;
  metrics: TradeMetrics;
  trades: TradeRowLite[];
  intraday: IntradayPoint[];
  note: string;
}

export default function JournalDayPage({ params }: { params: Promise<{ date: string }> }) {
  const { date } = use(params);
  return (
    <Suspense>
      <JournalDay key={date} date={date} />
    </Suspense>
  );
}

function JournalDay({ date }: { date: string }) {
  const { query, values: filters, timeZone } = useFilters();
  const { data, error, refresh } = useApi<DayPayload>(`/api/journal/${date}?${query}`);
  const [resetKey, setResetKey] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const noteEditor = useRef<RichEditorHandle>(null);
  const { save, status: saving, flush } = useAutosave(`/api/journal/${date}`, "PUT");
  const noteValue = note ?? data?.note ?? "";
  const latestNote = useRef(noteValue);
  latestNote.current = noteValue;
  const scheduleSave = (value: string) => {
    latestNote.current = value;
    setNote(value);
    save({ note: value });
  };

  const deleteJournal = async () => {
    if (
      !confirm(
        `Delete the journal for ${date}? The day note and its attachments are removed. Trades on this day are kept. This cannot be undone.`,
      )
    )
      return;
    setDeleting(true);
    setDeleteError("");
    try {
      // Let any queued autosave finish first so it can't write the note back afterwards.
      await flush();
      await postJson(`/api/journal/${date}`, undefined, "DELETE");
      latestNote.current = "";
      setNote("");
      setResetKey((key) => key + 1);
      refresh();
    } catch (cause) {
      setDeleteError(cause instanceof Error ? cause.message : "Couldn’t delete this journal.");
    } finally {
      setDeleting(false);
    }
  };

  const m = data?.metrics;
  // The shared day note is only sent to AI when no account or trade filter narrows the recap.
  const noteInScope = Object.keys(filters).every((key) => key === "from" || key === "to");
  return (
    <div>
      <FilterBar title={`Journal · ${date}`} />
      <div className="grid gap-3 p-4 xl:grid-cols-3">
        <div className="min-w-0 space-y-3 xl:col-span-2">
          {m && m.closedTrades > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Day stats</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3 2xl:grid-cols-5">
                <Stat label="Net P&L">
                  <Pnl value={m.netPnl} className="font-semibold" />
                </Stat>
                <Stat label="Trades">{m.closedTrades}</Stat>
                <Stat label="Winrate">{fmtPercent(m.winRate)}</Stat>
                <Stat label="Winners">{m.wins}</Stat>
                <Stat label="Losers">{m.losses}</Stat>
                <Stat label="Gross">
                  <MonetaryValue>{fmtMoney(m.grossPnl)}</MonetaryValue>
                </Stat>
                <Stat label="Fees">
                  <MonetaryValue>{fmtMoney(m.fees)}</MonetaryValue>
                </Stat>
                <Stat label="Volume">{fmtNumber(m.totalVolume, 0)}</Stat>
                <Stat label="Profit factor">
                  {m.profitFactorIsInfinite
                    ? "∞"
                    : m.profitFactor === null
                      ? "–"
                      : fmtNumber(m.profitFactor)}
                </Stat>
                <Stat label="Expectancy">
                  <MonetaryValue>
                    {m.expectancy === null ? "–" : fmtMoney(m.expectancy)}
                  </MonetaryValue>
                </Stat>
              </CardContent>
            </Card>
          ) : (
            m && (
              <Card>
                <CardContent className="py-8 text-center text-sm text-muted-foreground">
                  No closed trades this day.
                </CardContent>
              </Card>
            )
          )}

          {data && data.intraday.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Intraday cumulative net P&L</CardTitle>
              </CardHeader>
              <CardContent>
                <EquityArea
                  data={data.intraday.map((p) => ({
                    t: p.t.slice(11, 16),
                    cumNetPnl: p.cumNetPnl,
                  }))}
                  height={200}
                />
              </CardContent>
            </Card>
          )}

          {data && data.trades.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Trades</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1">
                {data.trades.map((trade) => (
                  <Link
                    key={trade.key}
                    href={`/trades/${encodeURIComponent(trade.key)}?${query}`}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent/60"
                  >
                    <span className="flex items-center gap-2">
                      <Badge
                        variant={
                          trade.status === "win"
                            ? "profit"
                            : trade.status === "loss"
                              ? "loss"
                              : "secondary"
                        }
                      >
                        {trade.status.toUpperCase()}
                      </Badge>
                      <span className="font-medium">{trade.symbol}</span>
                      <span className="text-xs text-muted-foreground">{trade.direction}</span>
                    </span>
                    <span className="ml-auto flex flex-wrap items-center justify-end gap-x-4 gap-y-1">
                      <span className="tnum text-xs text-muted-foreground">
                        {fmtNumber(trade.quantity, 4)} @{" "}
                        <MonetaryValue>{fmtNumber(trade.avgEntry)}</MonetaryValue>
                        {trade.avgExit !== null && (
                          <>
                            {" "}
                            → <MonetaryValue>{fmtNumber(trade.avgExit)}</MonetaryValue>
                          </>
                        )}
                      </span>
                      <Pnl value={trade.netPnl} />
                    </span>
                  </Link>
                ))}
              </CardContent>
            </Card>
          )}
          {!data && <Skeleton className="h-64" />}
        </div>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle>Day note</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-3 text-xs text-muted-foreground">
              This note is shared across accounts. AI recaps use the selected filters and append a
              labeled section. Shared notes are excluded from filtered AI context.
            </p>
            <div className="mb-3">
              <AiRecap
                key={`${date}:${timeZone}:${query}`}
                date={date}
                filters={filters}
                timeZone={timeZone}
                disabled={!data || (!m?.closedTrades && !(noteInScope && noteValue.trim()))}
                disabledReason={
                  data
                    ? noteInScope
                      ? "AI recap needs a closed trade on this day or something written in the day note."
                      : "No closed trades match these filters on this day. Clear the filters to recap from your day note."
                    : undefined
                }
                beforeRequest={flush}
                onRecap={({ recap, scope }) => {
                  // Append to the current draft, including edits made while AI was running.
                  const section = `## AI recap\n\n${scope.label.replace(/[\\`*_{}\[\]<>#]/g, "").replace(/[\r\n]+/g, " ")}\n\n${recap}`;
                  scheduleSave(
                    latestNote.current ? `${latestNote.current}\n\n---\n\n${section}` : section,
                  );
                }}
              />
            </div>
            {data ? (
              <RichEditor
                key={`note-${resetKey}`}
                editorRef={noteEditor}
                value={noteValue}
                onChange={scheduleSave}
                aiContext={`Daily journal note for ${date}`}
              />
            ) : error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : (
              <Skeleton className="h-48" />
            )}
            <div className="flex flex-wrap items-center justify-between gap-1 text-xs text-muted-foreground">
              <span role="status">{saving}</span>
              <span className="flex items-center gap-1">
                <Button variant="ghost" size="sm" onClick={() => void flush()}>
                  Save now
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  disabled={!data || deleting}
                  onClick={() => void deleteJournal()}
                >
                  <Trash2 />
                  {deleting ? "Deleting…" : "Delete journal"}
                </Button>
              </span>
            </div>
            {deleteError && (
              <p role="alert" className="text-xs text-destructive">
                {deleteError}
              </p>
            )}
            <DailyReportExport date={date} query={query} note={note !== null ? note : undefined} />
            <Attachments key={`files-${resetKey}`} type="day" id={date} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="tnum">{children}</div>
    </div>
  );
}
