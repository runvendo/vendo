"use client"

import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { cn } from "@/lib/cn"
import { formatUSD } from "@/lib/money"

interface AreaTrendProps {
  data: { x: string; y: number }[]
  className?: string
  height?: number
}

interface TooltipPayload {
  payload: { x: string; y: number }
}

function TrendTooltip({ active, payload }: { active?: boolean; payload?: TooltipPayload[] }) {
  if (!active || !payload?.length) return null
  const { x, y } = payload[0].payload
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2 shadow-[0_1px_3px_rgba(17,17,17,.06),0_10px_28px_-14px_rgba(17,17,17,.12)]">
      <div className="text-[11px] uppercase tracking-[0.08em] text-muted">{x}</div>
      <div className="text-sm font-semibold text-ink tabular-nums">{formatUSD(y)}</div>
    </div>
  )
}

/** Monochrome balance/net-worth trend. Single ink series with a faint area gradient. */
export function AreaTrend({ data, className, height = 220 }: AreaTrendProps) {
  return (
    <div className={cn("w-full", className)}>
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={data} margin={{ top: 6, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="area-trend-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-ink)" stopOpacity={0.1} />
              <stop offset="100%" stopColor="var(--color-ink)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="x"
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 11, fill: "var(--color-muted)" }}
            minTickGap={24}
          />
          <YAxis hide domain={["dataMin", "dataMax"]} />
          <Tooltip
            content={<TrendTooltip />}
            cursor={{ stroke: "var(--color-border-strong)", strokeWidth: 1 }}
          />
          <Area
            type="monotone"
            dataKey="y"
            stroke="var(--color-ink)"
            strokeWidth={1.8}
            fill="url(#area-trend-fill)"
            dot={false}
            activeDot={{ r: 3, fill: "var(--color-ink)", stroke: "var(--color-surface)", strokeWidth: 2 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
