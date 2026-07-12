"use client"

import { cn } from "@/lib/cn"
import { formatUSD } from "@/lib/money"

interface BarItem {
  label: string
  value: number
  color?: string
  max?: number
}

interface BarsProps {
  items: BarItem[]
  className?: string
}

/** Horizontal ranked bars, hand-rolled with divs. Used for category spend and budgets. */
export function Bars({ items, className }: BarsProps) {
  const globalMax = Math.max(...items.map((i) => i.value), 1)

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {items.map((item) => {
        const max = item.max ?? globalMax
        const pct = Math.min(100, Math.max(0, (item.value / (max || 1)) * 100))
        return (
          <div key={item.label} className="flex items-center gap-3">
            <span className="w-24 shrink-0 truncate text-sm text-ink">{item.label}</span>
            <div className="h-2 flex-1 rounded-full bg-hover">
              <div
                className="h-2 rounded-full"
                style={{ width: `${pct}%`, background: item.color ?? "var(--color-ink)" }}
              />
            </div>
            <span className="w-20 shrink-0 text-right text-sm tabular-nums text-muted">
              {formatUSD(item.value)}
            </span>
          </div>
        )
      })}
    </div>
  )
}
