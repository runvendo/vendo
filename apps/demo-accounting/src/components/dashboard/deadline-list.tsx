"use client"

import Link from "next/link"
import { ArrowUpRight, CalendarCheck2 } from "lucide-react"
import useSWR from "swr"
import { Badge, type BadgeVariant } from "@/components/ui/badge"
import { Card, CardHeader } from "@/components/ui/card"
import { EmptyState } from "@/components/ui/empty-state"
import { ErrorState } from "@/components/ui/error-state"
import { ProgressBar } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { fetcher, type DeadlineEntry } from "@/lib/api"
import { cn } from "@/lib/cn"
import { daysUntil, entityLabel, formatDate } from "@/lib/format"

function urgency(days: number): { variant: BadgeVariant; label: string } {
  if (days < 0) return { variant: "overdue", label: `${-days}d overdue` }
  if (days === 0) return { variant: "overdue", label: "Due today" }
  if (days <= 21) return { variant: "missing", label: `in ${days} days` }
  return { variant: "neutral", label: `in ${days} days` }
}

function DeadlineRow({ entry }: { entry: DeadlineEntry }) {
  const days = daysUntil(entry.filingDeadline)
  const badge = urgency(days)
  return (
    <li>
      <Link
        href={`/clients/${entry.id}`}
        className="group flex items-center gap-6 px-5 py-3.5 transition-colors hover:bg-surface/70"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13.5px] font-medium">{entry.businessName}</span>
            <Badge>{entityLabel(entry.entityType)}</Badge>
          </div>
          <p className="mt-1 truncate text-[12px] text-ink-faint">
            {entry.missingDocKinds.length > 0 ? (
              <>
                <span className="font-medium text-status-missing">Missing:</span>{" "}
                {entry.missingDocKinds.join(", ")}
              </>
            ) : entry.status === "in_review" ? (
              "All documents in — awaiting review"
            ) : (
              "All documents verified"
            )}
          </p>
        </div>
        <div className="w-28 shrink-0">
          <div className="flex items-center justify-between text-[11px] text-ink-faint tabular-nums">
            <span>
              {entry.progress.received} of {entry.progress.total}
            </span>
            <span>{formatDate(entry.filingDeadline)}</span>
          </div>
          <ProgressBar value={entry.progress.received} max={entry.progress.total} className="mt-1.5" />
        </div>
        <Badge variant={badge.variant} className="w-24 justify-center tabular-nums">
          {badge.label}
        </Badge>
        <ArrowUpRight
          size={14}
          className={cn(
            "shrink-0 text-ink-faint opacity-0 transition-opacity group-hover:opacity-100",
          )}
        />
      </Link>
    </li>
  )
}

export function DeadlineList({ className }: { className?: string }) {
  const { data, error } = useSWR<DeadlineEntry[]>("/api/deadlines", fetcher)
  const entries = data?.slice(0, 5)

  return (
    <Card className={cn("overflow-hidden", className)}>
      <CardHeader
        title="Upcoming deadlines"
        action={
          <Link
            href="/calendar"
            className="text-[12px] font-medium text-evergreen-600 transition-colors hover:text-evergreen-800"
          >
            View calendar
          </Link>
        }
      />
      {error ? (
        <ErrorState title="Couldn't load deadlines" />
      ) : !entries ? (
        <div className="space-y-4 px-5 pt-1 pb-5">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="flex items-center gap-6">
              <div className="flex-1">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="mt-2 h-3 w-64" />
              </div>
              <Skeleton className="h-3 w-28" />
              <Skeleton className="h-5 w-24 rounded-full" />
            </div>
          ))}
        </div>
      ) : entries.length === 0 ? (
        <EmptyState
          icon={CalendarCheck2}
          title="No upcoming deadlines"
          description="Filing deadlines will appear here as client engagements are added."
        />
      ) : (
        <ul className="divide-y divide-line/70 border-t border-line/70">
          {entries.map(entry => (
            <DeadlineRow key={entry.id} entry={entry} />
          ))}
        </ul>
      )}
    </Card>
  )
}
