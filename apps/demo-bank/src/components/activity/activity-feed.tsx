"use client"
import * as React from "react"
import {
  ArrowDownLeft, CreditCard, AlertTriangle, ShieldCheck, ArrowLeftRight, Bell,
  type LucideIcon,
} from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useToast } from "@/components/ui/toast"
import { useNotifications } from "@/lib/hooks"
import { formatTime, relativeDay } from "@/lib/format"
import { cn } from "@/lib/cn"
import type { Notification } from "@/server/types"

const ICONS: Record<Notification["kind"], LucideIcon> = {
  deposit: ArrowDownLeft,
  card: CreditCard,
  alert: AlertTriangle,
  security: ShieldCheck,
  transfer: ArrowLeftRight,
}

function groupByDay(items: Notification[]) {
  const groups: { day: string; items: Notification[] }[] = []
  for (const n of items) {
    const day = relativeDay(n.at)
    const last = groups[groups.length - 1]
    if (last && last.day === day) last.items.push(n)
    else groups.push({ day, items: [n] })
  }
  return groups
}

function FeedRow({ n }: { n: Notification }) {
  const Icon = ICONS[n.kind]
  return (
    <div className={cn("flex items-start gap-3 rounded-xl px-3 py-3", !n.read && "bg-hover")}>
      <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-border bg-surface text-ink-soft">
        <Icon className="h-4 w-4" strokeWidth={1.75} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-sm font-medium text-ink">{n.title}</span>
          <span className="shrink-0 text-xs tabular-nums text-muted">{formatTime(n.at)}</span>
        </div>
        <p className="mt-0.5 text-xs text-muted">{n.body}</p>
      </div>
      {!n.read && <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-ink" />}
    </div>
  )
}

function LoadingFeed() {
  return (
    <Card>
      <CardContent className="space-y-1 py-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-start gap-3 px-3 py-3">
            <Skeleton className="h-9 w-9 rounded-[10px]" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3.5 w-40" />
              <Skeleton className="h-3 w-56" />
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

export function ActivityFeed() {
  const { data, isLoading } = useNotifications()
  const toast = useToast()
  const [readIds, setReadIds] = React.useState<Set<string>>(new Set())

  if (isLoading || !data) return <LoadingFeed />

  const items = data.map((n) => (readIds.has(n.id) ? { ...n, read: true } : n))
  const unreadCount = items.filter((n) => !n.read).length
  const groups = groupByDay(items)

  const markAllRead = () => {
    setReadIds(new Set(data.map((n) => n.id)))
    toast({ title: "All caught up" })
  }

  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-full border border-border bg-hover text-ink-soft">
            <Bell className="h-5 w-5" strokeWidth={1.75} />
          </span>
          <div>
            <div className="text-sm font-medium text-ink">No activity yet</div>
            <p className="mt-1 text-xs text-muted">Notifications about your money will show up here.</p>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-end">
        <Button variant="secondary" size="sm" onClick={markAllRead} disabled={unreadCount === 0}>
          Mark all read
        </Button>
      </div>
      {groups.map((g) => (
        <div key={g.day} className="space-y-2">
          <h2 className="px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
            {g.day}
          </h2>
          <Card>
            <CardContent className="space-y-1 py-2">
              {g.items.map((n) => (
                <FeedRow key={n.id} n={n} />
              ))}
            </CardContent>
          </Card>
        </div>
      ))}
    </div>
  )
}
