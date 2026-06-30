"use client"

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts"
import { cn } from "@/lib/cn"
import { formatUSD } from "@/lib/money"
import type { SpendingSlice } from "@/server/types"
import { categoryColor, categoryLabel } from "./colors"

interface DonutProps {
  data: SpendingSlice[]
  className?: string
  size?: number
}

interface SliceTooltipPayload {
  payload: SpendingSlice
}

function SliceTooltip({ active, payload }: { active?: boolean; payload?: SliceTooltipPayload[] }) {
  if (!active || !payload?.length) return null
  const slice = payload[0].payload
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2 shadow-[0_1px_3px_rgba(17,17,17,.06),0_10px_28px_-14px_rgba(17,17,17,.12)]">
      <div className="flex items-center gap-2">
        <span
          className="inline-block size-2 rounded-full"
          style={{ background: categoryColor(slice.category) }}
        />
        <span className="text-[13px] text-ink">{categoryLabel(slice.category)}</span>
      </div>
      <div className="mt-0.5 text-sm font-semibold text-ink tabular-nums">
        {formatUSD(slice.amount)}
      </div>
    </div>
  )
}

/** Spending-by-category donut with a centered total label. */
export function Donut({ data, className, size = 200 }: DonutProps) {
  const total = data.reduce((sum, s) => sum + s.amount, 0)

  return (
    <div
      className={cn("relative", className)}
      style={{ width: size, height: size }}
    >
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            dataKey="amount"
            nameKey="category"
            innerRadius={size * 0.31}
            outerRadius={size * 0.46}
            paddingAngle={2}
            startAngle={90}
            endAngle={-270}
            stroke="none"
          >
            {data.map((slice) => (
              <Cell key={slice.category} fill={categoryColor(slice.category)} />
            ))}
          </Pie>
          <Tooltip content={<SliceTooltip />} />
        </PieChart>
      </ResponsiveContainer>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-[11px] uppercase tracking-[0.08em] text-muted">Total</span>
        <span className="text-lg font-semibold text-ink tabular-nums">{formatUSD(total)}</span>
      </div>
    </div>
  )
}
