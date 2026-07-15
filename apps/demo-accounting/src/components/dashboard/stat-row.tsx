"use client"

import { CalendarClock, FileStack, FolderCheck } from "lucide-react"
import useSWR from "swr"
import { MissingDocsHero } from "@/components/dashboard/missing-docs-hero"
import { Card } from "@/components/ui/card"
import { ErrorState } from "@/components/ui/error-state"
import { ProgressBar } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { StatTile } from "@/components/ui/stat-tile"
import { fetcher, type DashboardData } from "@/lib/api"
import { daysUntil, formatDate } from "@/lib/format"

function StatRowSkeleton() {
  return (
    <div className="grid grid-cols-4 gap-4">
      {Array.from({ length: 4 }, (_, i) => (
        <Card key={i} className="p-5">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="mt-4 h-8 w-16" />
          <Skeleton className="mt-3 h-3 w-24" />
        </Card>
      ))}
    </div>
  )
}

function DeadlineCountdown({ data }: { data: DashboardData }) {
  const client = data.nearestDeadlineClient
  if (!client) {
    return (
      <StatTile
        label="Next filing deadline"
        value="—"
        sub="No upcoming deadlines"
        icon={CalendarClock}
      />
    )
  }
  const days = daysUntil(client.filingDeadline)
  return (
    <StatTile
      label="Next filing deadline"
      value={
        <>
          {days}
          <span className="ml-1.5 text-[15px] font-medium tracking-normal text-ink-soft">
            days
          </span>
        </>
      }
      sub={
        <>
          <span className="font-medium text-ink-soft">{client.businessName}</span>
          {" · "}
          {formatDate(client.filingDeadline)}
        </>
      }
      icon={CalendarClock}
      iconClassName="bg-status-missing-bg text-status-missing"
    />
  )
}

export function StatRow() {
  const { data, error } = useSWR<DashboardData>("/api/dashboard", fetcher)
  if (error) {
    return (
      <Card>
        <ErrorState title="Couldn't load dashboard metrics" />
      </Card>
    )
  }
  if (!data) return <StatRowSkeleton />

  return (
    <div className="grid grid-cols-4 gap-4">
      <MissingDocsHero missingCount={data.clientsMissingDocs} clientCount={data.clientsTotal} />
      <StatTile
        label="Documents outstanding"
        value={data.documentsOutstanding}
        sub="still to collect this season"
        icon={FileStack}
      />
      <StatTile
        label="Documents received"
        value={
          <>
            {data.documentsReceived}
            <span className="ml-1.5 text-[15px] font-medium tracking-normal text-ink-soft">
              of {data.documentsTotal}
            </span>
          </>
        }
        sub={<ProgressBar value={data.documentsReceived} max={data.documentsTotal} />}
        icon={FolderCheck}
        iconClassName="bg-status-verified-bg text-status-verified"
      />
      <DeadlineCountdown data={data} />
    </div>
  )
}
