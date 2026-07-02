"use client"

import { CalendarClock, FileStack, FolderCheck } from "lucide-react"
import useSWR from "swr"
import { Card } from "@/components/ui/card"
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

/** The demo's hero number: clients with documents still outstanding. */
function MissingDocsHero({ data }: { data: DashboardData }) {
  return (
    <Card className="border-evergreen-900 bg-gradient-to-br from-evergreen-800 to-evergreen-950 p-5">
      <p className="text-[13px] font-medium whitespace-nowrap text-evergreen-100/80">
        Clients missing documents
      </p>
      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="text-[40px] leading-none font-semibold tracking-tight text-white tabular-nums">
          {data.clientsMissingDocs}
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-status-missing-bg px-2 py-0.5 text-[11px] font-medium whitespace-nowrap text-status-missing">
          <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
          Action needed
        </span>
      </div>
      <p className="mt-2.5 text-[12px] text-evergreen-100/60">
        of {data.clientsTotal} active clients need chasing
      </p>
    </Card>
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
  const { data } = useSWR<DashboardData>("/api/dashboard", fetcher)
  if (!data) return <StatRowSkeleton />

  return (
    <div className="grid grid-cols-4 gap-4">
      <MissingDocsHero data={data} />
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
