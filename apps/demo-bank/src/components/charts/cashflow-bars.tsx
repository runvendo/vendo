"use client"

import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { cn } from "@/lib/cn"
import { formatUSD } from "@/lib/money"
import type { CashflowPoint } from "@/server/types"

interface CashflowBarsProps {
  data: CashflowPoint[]
  className?: string
  height?: number
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** Turn a "2026-06" label into a short month like "Jun". Falls back to the raw label. */
function shortMonth(label: string): string {
  const month = Number(label.split("-")[1])
  return MONTHS[month - 1] ?? label
}

interface CashflowTooltipPayload {
  payload: CashflowPoint
}

function CashflowTooltip({
  active,
  payload,
}: {
  active?: boolean
  payload?: CashflowTooltipPayload[]
}) {
  if (!active || !payload?.length) return null
  const point = payload[0].payload
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2 shadow-[0_1px_3px_rgba(17,17,17,.06),0_10px_28px_-14px_rgba(17,17,17,.12)]">
      <div className="text-[11px] uppercase tracking-[0.08em] text-muted">{shortMonth(point.label)}</div>
      <div className="mt-1 flex items-center justify-between gap-4 text-[13px]">
        <span className="text-muted">In</span>
        <span className="font-semibold text-pos tabular-nums">{formatUSD(point.in)}</span>
      </div>
      <div className="flex items-center justify-between gap-4 text-[13px]">
        <span className="text-muted">Out</span>
        <span className="font-semibold text-ink tabular-nums">{formatUSD(point.out)}</span>
      </div>
    </div>
  )
}

/** Paired in/out bars per month. */
export function CashflowBars({ data, className, height = 200 }: CashflowBarsProps) {
  return (
    <div className={cn("w-full", className)}>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} margin={{ top: 6, right: 0, bottom: 0, left: 0 }} barGap={2}>
          <XAxis
            dataKey="label"
            tickFormatter={shortMonth}
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 11, fill: "var(--color-muted)" }}
          />
          <YAxis hide />
          <Tooltip
            content={<CashflowTooltip />}
            cursor={{ fill: "var(--color-hover)" }}
          />
          <Bar dataKey="in" fill="var(--color-pos)" radius={[3, 3, 0, 0]} maxBarSize={18} animationDuration={700} />
          <Bar dataKey="out" fill="var(--color-muted)" radius={[3, 3, 0, 0]} maxBarSize={18} animationDuration={700} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
