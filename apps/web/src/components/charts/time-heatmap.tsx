"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fmtMoney, fmtNumber } from "@/lib/utils";
import { usePrivacy } from "../privacy";
import { tooltipStyle, useVizTokens } from "./tokens";
import { ChartFrame } from "./chart-frame";

interface HourBucket {
  key: string; // "09"
  netPnl: number;
  trades: number;
}

const SYNC_ID = "time-of-day";
const AXIS_WIDTH = 64;

/**
 * Time-of-day performance (Recharts). Two aligned rows sharing the hour axis
 * and a linked tooltip: P&L per opening hour as diverging columns, trade
 * count as a muted line. One value axis per pane — never dual-axis on one grid.
 */
export function TimeHeatmap({
  hours,
  height = 300,
  currency = "USD",
}: {
  hours: HourBucket[];
  height?: number;
  currency?: string;
}) {
  const t = useVizTokens();
  const privateMode = usePrivacy();
  if (!t) return <div style={{ height }} />;

  const data = hours.map((h) => ({
    hour: `${h.key}:00`,
    netPnl: h.netPnl,
    trades: h.trades,
  }));
  const pnlHeight = Math.round(height * 0.66);
  const tickStyle = { fill: t.inkMuted, fontSize: 11 };
  const labelStyle = { fill: t.inkMuted, fontSize: 11, textAnchor: "middle" as const };
  const margin = { top: 8, right: 16, bottom: 0, left: 0 };

  return (
    <div style={{ height }}>
      <ChartFrame height={pnlHeight}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            key={String(privateMode)}
            data={data}
            syncId={SYNC_ID}
            margin={margin}
            barCategoryGap="20%"
          >
            <CartesianGrid stroke={t.gridline} strokeWidth={1} vertical={false} />
            <XAxis dataKey="hour" tick={false} tickLine={false} axisLine={{ stroke: t.baseline }} />
            <YAxis
              width={AXIS_WIDTH}
              tick={tickStyle}
              tickLine={false}
              axisLine={false}
              tickFormatter={(value: number) => (privateMode ? "••••" : fmtNumber(value, 0))}
              label={{
                value: privateMode ? "Net P&L (hidden)" : `Net P&L (${currency})`,
                angle: -90,
                position: "insideLeft",
                style: labelStyle,
              }}
            />
            <ReferenceLine y={0} stroke={t.baseline} />
            <Tooltip
              contentStyle={tooltipStyle(t)}
              formatter={(value) => [
                privateMode ? "Hidden" : fmtMoney(Number(value), currency),
                "Net P&L",
              ]}
              cursor={{ fill: t.gridline, opacity: 0.4 }}
            />
            <Bar dataKey="netPnl" isAnimationActive={false} maxBarSize={26}>
              {data.map((entry) => (
                <Cell
                  key={entry.hour}
                  fill={entry.netPnl >= 0 ? t.profitFill : t.loss}
                  radius={(entry.netPnl >= 0 ? [4, 4, 0, 0] : [0, 0, 4, 4]) as unknown as number}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartFrame>
      <ChartFrame height={height - pnlHeight}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} syncId={SYNC_ID} margin={{ ...margin, top: 4, bottom: 4 }}>
            <XAxis
              dataKey="hour"
              tick={tickStyle}
              tickLine={false}
              axisLine={{ stroke: t.baseline }}
              minTickGap={8}
            />
            <YAxis
              width={AXIS_WIDTH}
              tick={tickStyle}
              tickLine={false}
              axisLine={false}
              allowDecimals={false}
              label={{ value: "Trades", angle: -90, position: "insideLeft", style: labelStyle }}
            />
            <Tooltip
              contentStyle={tooltipStyle(t)}
              formatter={(value) => [fmtNumber(Number(value), 0), "Trades"]}
            />
            <Line
              dataKey="trades"
              type="linear"
              stroke={t.inkMuted}
              strokeWidth={2}
              dot={{ r: 3, fill: t.inkMuted, stroke: t.inkMuted }}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </ChartFrame>
    </div>
  );
}
