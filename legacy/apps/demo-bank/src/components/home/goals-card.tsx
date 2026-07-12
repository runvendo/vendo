"use client"
import { Plane, ShieldCheck, Laptop, Target, type LucideIcon } from "lucide-react"
import { useGoals } from "@/lib/hooks"
import { formatUSD } from "@/lib/money"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

const GOAL_ICONS: Record<string, LucideIcon> = {
  plane: Plane,
  shield: ShieldCheck,
  laptop: Laptop,
}

export function GoalsCard() {
  const { data, isLoading } = useGoals()

  return (
    <Card>
      <CardHeader>
        <CardTitle>Goals</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading || !data ? (
          Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-3.5 w-32" />
              <Skeleton className="h-2 w-full" />
            </div>
          ))
        ) : (
          data.map((g) => {
            const pct = g.target > 0 ? Math.min(100, Math.round((g.saved / g.target) * 100)) : 0
            return (
              <div key={g.id}>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    {(() => {
                      const Icon = GOAL_ICONS[g.icon] ?? Target
                      return <Icon className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                    })()}
                    <span className="truncate text-sm font-medium text-ink">{g.name}</span>
                  </div>
                  <span className="shrink-0 text-xs tabular-nums text-muted">{pct}%</span>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-hover">
                  <div className="h-full rounded-full bg-ink" style={{ width: `${pct}%` }} />
                </div>
                <div className="mt-1.5 text-xs tabular-nums text-muted">
                  {formatUSD(g.saved)} <span className="text-muted/70">/ {formatUSD(g.target)}</span>
                </div>
              </div>
            )
          })
        )}
      </CardContent>
    </Card>
  )
}
