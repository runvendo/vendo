import { cn } from "@/lib/cn"

/** Thin document-collection meter. Turns verified-green when complete. */
export function ProgressBar({
  value,
  max,
  className,
}: {
  value: number
  max: number
  className?: string
}) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0
  return (
    <div
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-line/80", className)}
    >
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-500",
          pct >= 100 ? "bg-status-verified" : "bg-evergreen-500",
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}
