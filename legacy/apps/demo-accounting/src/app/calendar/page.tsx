"use client"

import Link from "next/link"
import { ArrowUpRight, CalendarCheck2 } from "lucide-react"
import useSWR from "swr"
import { deadlineUrgency } from "@/components/clients/meta"
import { Badge } from "@/components/ui/badge"
import { Card, CardHeader } from "@/components/ui/card"
import { EmptyState } from "@/components/ui/empty-state"
import { ErrorState } from "@/components/ui/error-state"
import { PageHeader } from "@/components/ui/page-header"
import { Reveal } from "@/components/ui/reveal"
import { Skeleton } from "@/components/ui/skeleton"
import { fetcher, type DeadlineEntry } from "@/lib/api"
import { cn } from "@/lib/cn"
import { daysUntil, entityLabel } from "@/lib/format"

/** Deadlines are already sorted by date; bucket them into month sections. */
function groupByMonth(entries: DeadlineEntry[]): { label: string; entries: DeadlineEntry[] }[] {
  const groups: { label: string; entries: DeadlineEntry[] }[] = []
  for (const entry of entries) {
    const label = new Date(entry.filingDeadline).toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
    })
    const last = groups[groups.length - 1]
    if (last && last.label === label) last.entries.push(entry)
    else groups.push({ label, entries: [entry] })
  }
  return groups
}

function DateTile({ iso, urgent }: { iso: string; urgent: boolean }) {
  const date = new Date(iso)
  return (
    <div
      className={cn(
        "flex h-11 w-11 shrink-0 flex-col items-center justify-center rounded-lg border",
        urgent ? "border-status-missing/30 bg-status-missing-bg" : "border-line bg-surface",
      )}
    >
      <span
        className={cn(
          "text-[9px] font-semibold tracking-[0.08em] uppercase",
          urgent ? "text-status-missing" : "text-ink-faint",
        )}
      >
        {date.toLocaleDateString("en-US", { month: "short" })}
      </span>
      <span className="text-[16px] leading-tight font-semibold tabular-nums">{date.getDate()}</span>
    </div>
  )
}

function DeadlineRow({ entry }: { entry: DeadlineEntry }) {
  const days = daysUntil(entry.filingDeadline)
  const urgency = deadlineUrgency(days)
  return (
    <li>
      <Link
        href={`/clients/${entry.id}`}
        className="group flex items-center gap-4 px-5 py-3 transition-colors hover:bg-surface/70"
      >
        <DateTile iso={entry.filingDeadline} urgent={days <= 21} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13.5px] font-medium">{entry.businessName}</span>
            <Badge>{entityLabel(entry.entityType)}</Badge>
          </div>
          <p className="mt-0.5 truncate text-[12px] text-ink-faint">
            {entry.missingDocKinds.length > 0 ? (
              <>
                <span className="font-medium text-status-missing">Still missing:</span>{" "}
                {entry.missingDocKinds.join(", ")}
              </>
            ) : entry.status === "in_review" ? (
              "All documents in — awaiting review"
            ) : (
              "Ready to file — all documents verified"
            )}
          </p>
        </div>
        <span className="w-24 shrink-0 text-right text-[11px] text-ink-faint tabular-nums">
          {new Date(entry.filingDeadline).toLocaleDateString("en-US", { weekday: "long" })}
        </span>
        <Badge variant={urgency.variant} className="w-24 justify-center tabular-nums">
          {urgency.label}
        </Badge>
        <ArrowUpRight
          size={14}
          className="shrink-0 text-ink-faint opacity-0 transition-opacity group-hover:opacity-100"
        />
      </Link>
    </li>
  )
}

function CalendarSkeleton() {
  return (
    <div className="space-y-4">
      {Array.from({ length: 2 }, (_, g) => (
        <Card key={g} className="overflow-hidden">
          <div className="px-5 pt-4 pb-3">
            <Skeleton className="h-4 w-32" />
          </div>
          <div className="space-y-4 border-t border-line/70 px-5 py-4">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="flex items-center gap-4">
                <Skeleton className="h-11 w-11 shrink-0 rounded-lg" />
                <div className="flex-1">
                  <Skeleton className="h-4 w-56" />
                  <Skeleton className="mt-1.5 h-3 w-72" />
                </div>
                <Skeleton className="h-5 w-24 rounded-full" />
              </div>
            ))}
          </div>
        </Card>
      ))}
    </div>
  )
}

export default function CalendarPage() {
  const { data, error } = useSWR<DeadlineEntry[]>("/api/deadlines", fetcher)
  const groups = data ? groupByMonth(data) : undefined

  return (
    <div className="space-y-6">
      <Reveal delay={0}>
        <PageHeader
          title="Calendar"
          description="Every filing deadline this season, soonest first"
          actions={
            data && (
              <span className="text-[13px] text-ink-faint tabular-nums">
                {data.length} deadlines
              </span>
            )
          }
        />
      </Reveal>
      {error ? (
        <Reveal delay={0.05}>
          <Card>
            <ErrorState title="Couldn't load deadlines" />
          </Card>
        </Reveal>
      ) : !groups ? (
        <CalendarSkeleton />
      ) : groups.length === 0 ? (
        <Reveal delay={0.05}>
          <Card>
            <EmptyState
              icon={CalendarCheck2}
              title="No upcoming deadlines"
              description="Filing deadlines will appear here as client engagements are added."
            />
          </Card>
        </Reveal>
      ) : (
        groups.map((group, i) => (
          <Reveal key={group.label} delay={0.05 + i * 0.05}>
            <Card className="overflow-hidden">
              <CardHeader
                title={group.label}
                action={
                  <span className="text-[12px] text-ink-faint tabular-nums">
                    {group.entries.length} {group.entries.length === 1 ? "filing" : "filings"}
                  </span>
                }
              />
              <ul className="divide-y divide-line/60 border-t border-line/70">
                {group.entries.map(entry => (
                  <DeadlineRow key={entry.id} entry={entry} />
                ))}
              </ul>
            </Card>
          </Reveal>
        ))
      )}
    </div>
  )
}
