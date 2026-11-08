import { bad, handler, ok } from "@/server/api";
import { getTradeReport } from "@/server/daily-report";
import { getTradeByKey } from "@/server/trades-query";

type Params = { params: Promise<{ key: string }> };

export const GET = handler(async (_request: Request, { params }: Params) => {
  const { key } = await params;
  if (!getTradeByKey(key)) return bad("Trade not found", 404);
  return ok(await getTradeReport(key));
});
