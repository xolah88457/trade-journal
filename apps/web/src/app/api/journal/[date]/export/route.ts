import { bad, handler, ok } from "@/server/api";
import {
  getDailyReport,
  isValidCalendarDate,
  parseAndValidateDailyFilters,
} from "@/server/daily-report";

type Params = { params: Promise<{ date: string }> };

export const GET = handler(async (request: Request, { params }: Params) => {
  const { date } = await params;
  if (!isValidCalendarDate(date)) {
    return bad("date must be a valid calendar YYYY-MM-DD");
  }

  const url = new URL(request.url);
  const filters = parseAndValidateDailyFilters(url.searchParams);
  const report = await getDailyReport(date, filters);
  return ok(report);
});
