import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/cn"
import { Card } from "./card"

/**
 * Dashboard metric tile. `iconClassName` sets the icon chip tint (defaults to
 * brand evergreen); status tints belong to document/deadline metrics only.
 */
export function StatTile({
  label,
  value,
  sub,
  icon: Icon,
  iconClassName,
  className,
}: {
  label: string
  value: React.ReactNode
  sub?: React.ReactNode
  icon?: LucideIcon
  iconClassName?: string
  className?: string
}) {
  return (
    <Card className={cn("p-5", className)}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-[13px] font-medium text-ink-soft">{label}</p>
        {Icon && (
          <span
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
              iconClassName ?? "bg-evergreen-50 text-evergreen-600",
            )}
          >
            <Icon size={16} strokeWidth={1.75} />
          </span>
        )}
      </div>
      <div className="mt-3 text-[32px] leading-none font-semibold tracking-tight tabular-nums">
        {value}
      </div>
      {sub && <div className="mt-2.5 text-[12px] text-ink-faint">{sub}</div>}
    </Card>
  )
}
