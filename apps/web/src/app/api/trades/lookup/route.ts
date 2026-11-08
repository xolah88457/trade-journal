import { db } from "@/db";
import { handler, ok } from "@/server/api";
import type { LinkableTrade } from "@/lib/trade-links";

/** Stop after 51 matches; retain Unicode-aware searching without loading the entire history. */
export const GET = handler((request: Request) => {
  const search = new URL(request.url).searchParams.get("q")?.trim().toLowerCase() ?? "";
  // SQLite folds ASCII case only, so it may drop rows for plain-ASCII searches while rows with
  // any other character always reach the exact JS check below.
  const prefilter = /^[\x20-\x7e]+$/.test(search);
  const candidates = db.$client
    .prepare(
      `
    SELECT * FROM (
      SELECT t.key, t.symbol, t.direction, t.opened_at AS openedAt,
        COALESCE(a.name, 'Unknown account') AS accountName
      FROM trades t LEFT JOIN accounts a ON a.id = t.account_id
    )
    ${
      prefilter
        ? `WHERE instr(lower(symbol || ' ' || openedAt || ' ' || accountName), @search) > 0
      OR (symbol || ' ' || openedAt || ' ' || accountName) GLOB '*[^ -~]*'`
        : ""
    }
    ORDER BY openedAt DESC
  `,
    )
    .iterate(prefilter ? { search } : {}) as IterableIterator<LinkableTrade>;
  const matches: LinkableTrade[] = [];
  for (const trade of candidates) {
    if (!`${trade.symbol} ${trade.openedAt} ${trade.accountName}`.toLowerCase().includes(search))
      continue;
    matches.push(trade);
    if (matches.length === 51) break;
  }
  return ok({ trades: matches.slice(0, 50), hasMore: matches.length > 50 });
});
