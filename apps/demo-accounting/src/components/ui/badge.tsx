import { cn } from "@/lib/cn"

export type BadgeVariant = "missing" | "overdue" | "review" | "verified" | "neutral"

/** Single source of truth for status tinting; reused by icon chips etc. */
export const BADGE_VARIANTS: Record<BadgeVariant, string> = {
  missing: "bg-status-missing-bg text-status-missing",
  overdue: "bg-status-overdue-bg text-status-overdue",
  review: "bg-status-review-bg text-status-review",
  verified: "bg-status-verified-bg text-status-verified",
  neutral: "border border-line bg-surface text-ink-soft",
}

export function Badge({
  variant = "neutral",
  dot = false,
  className,
  children,
}: {
  variant?: BadgeVariant
  dot?: boolean
  className?: string
  children: React.ReactNode
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
        BADGE_VARIANTS[variant],
        className,
      )}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />}
      {children}
    </span>
  )
}
