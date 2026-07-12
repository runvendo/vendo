import type { Transaction } from "@/server/types"
import { formatDate, formatTime } from "@/lib/format"
import { cn } from "@/lib/cn"

export function StatusTimeline({ steps }: { steps: Transaction["statusTimeline"] }) {
  if (!steps?.length) return null
  // Latest state on top reads most naturally for a posted-then-authorized history.
  const ordered = steps.slice().reverse()
  return (
    <ol className="relative">
      {ordered.map((s, i) => {
        const last = i === ordered.length - 1
        const current = i === 0
        return (
          <li key={`${s.state}-${s.at}`} className="relative flex gap-3 pb-5 last:pb-0">
            {!last && (
              <span className="absolute left-[5px] top-3 bottom-0 w-px bg-border" aria-hidden />
            )}
            <span
              className={cn(
                "relative z-10 mt-1 h-[11px] w-[11px] shrink-0 rounded-full border",
                current ? "border-ink bg-ink" : "border-border-strong bg-surface",
              )}
              aria-hidden
            />
            <div className="-mt-0.5 min-w-0">
              <div className={cn("text-sm font-medium", current ? "text-ink" : "text-ink-soft")}>
                {s.state}
              </div>
              <div className="text-xs text-muted tabular-nums">
                {formatDate(s.at, { month: "short", day: "numeric" })} · {formatTime(s.at)}
              </div>
            </div>
          </li>
        )
      })}
    </ol>
  )
}
