"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { Search, Users } from "lucide-react"
import useSWR from "swr"
import { ClientMark } from "@/components/clients/client-marks"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { EmptyState } from "@/components/ui/empty-state"
import { ErrorState } from "@/components/ui/error-state"
import { ProgressBar } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { fetcher, type ClientSummary } from "@/lib/api"
import { cn } from "@/lib/cn"
import { daysUntil, entityLabel, formatDate } from "@/lib/format"
import type { ClientStatus } from "@/server/clients"
import { Avatar, CLIENT_STATUS_META, deadlineUrgency } from "./meta"

type StatusFilter = "all" | ClientStatus

const FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "missing_docs", label: "Missing documents" },
  { value: "in_review", label: "In review" },
  { value: "complete", label: "Complete" },
]

const COLUMNS = ["Business", "Entity", "Documents", "Deadline", "Assignee", "Status"] as const

function HeaderRow() {
  return (
    <tr className="border-b border-line">
      {COLUMNS.map(col => (
        <th
          key={col}
          scope="col"
          className="px-3 py-2.5 text-left text-[10.5px] font-semibold tracking-[0.08em] text-ink-faint uppercase first:pl-5 last:pr-5"
        >
          {col}
        </th>
      ))}
    </tr>
  )
}

function ClientRow({ client }: { client: ClientSummary }) {
  const router = useRouter()
  const urgency = deadlineUrgency(daysUntil(client.filingDeadline))
  const status = CLIENT_STATUS_META[client.status]
  return (
    <tr
      onClick={() => router.push(`/clients/${client.id}`)}
      className="group cursor-pointer border-b border-line/70 transition-colors last:border-b-0 hover:bg-surface/70"
    >
      <td className="px-3 py-3 pl-5">
        <Link
          href={`/clients/${client.id}`}
          onClick={e => e.stopPropagation()}
          className="flex min-w-0 items-center gap-3 focus:outline-none focus-visible:underline"
        >
          <ClientMark clientId={client.id} name={client.businessName} size={32} />
          <span className="min-w-0">
            <span className="block truncate text-[13.5px] font-medium underline-offset-2 transition-colors group-hover:underline">
              {client.businessName}
            </span>
            <span className="mt-0.5 block truncate text-[12px] text-ink-faint">
              {client.contactName} · {client.contactEmail}
            </span>
          </span>
        </Link>
      </td>
      <td className="px-3 py-3">
        <Badge>{entityLabel(client.entityType)}</Badge>
      </td>
      <td className="px-3 py-3">
        <p className="text-[12px] text-ink-soft tabular-nums">
          {client.progress.received} of {client.progress.total} received
        </p>
        <ProgressBar value={client.progress.received} max={client.progress.total} className="mt-1.5 w-28" />
      </td>
      <td className="px-3 py-3">
        <p className="text-[12.5px] tabular-nums">{formatDate(client.filingDeadline)}</p>
        <Badge variant={urgency.variant} className="mt-1 tabular-nums">
          {urgency.label}
        </Badge>
      </td>
      <td className="px-3 py-3">
        <div className="flex items-center gap-2">
          <Avatar initials={client.assignee?.initials ?? "—"} />
          <span className="truncate text-[12.5px] text-ink-soft">
            {client.assignee?.name ?? "Unassigned"}
          </span>
        </div>
      </td>
      <td className="px-3 py-3 pr-5">
        <Badge variant={status.variant} dot>
          {status.label}
        </Badge>
      </td>
    </tr>
  )
}

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 7 }, (_, i) => (
        <tr key={i} className="border-b border-line/70 last:border-b-0">
          <td className="px-3 py-3.5 pl-5">
            <Skeleton className="h-4 w-44" />
            <Skeleton className="mt-1.5 h-3 w-56" />
          </td>
          <td className="px-3 py-3.5">
            <Skeleton className="h-5 w-16 rounded-full" />
          </td>
          <td className="px-3 py-3.5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-2 h-1.5 w-28 rounded-full" />
          </td>
          <td className="px-3 py-3.5">
            <Skeleton className="h-3 w-14" />
            <Skeleton className="mt-2 h-5 w-20 rounded-full" />
          </td>
          <td className="px-3 py-3.5">
            <div className="flex items-center gap-2">
              <Skeleton className="h-6 w-6 rounded-full" />
              <Skeleton className="h-3 w-24" />
            </div>
          </td>
          <td className="px-3 py-3.5 pr-5">
            <Skeleton className="h-5 w-28 rounded-full" />
          </td>
        </tr>
      ))}
    </>
  )
}

/** Standalone loading shape — also serves as the Suspense fallback for the page. */
export function ClientTableSkeleton() {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <Skeleton className="h-8 w-64 rounded-lg" />
        <div className="ml-auto flex gap-1.5">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-7 w-24 rounded-full" />
          ))}
        </div>
      </div>
      <table className="w-full">
        <thead>
          <HeaderRow />
        </thead>
        <tbody>
          <SkeletonRows />
        </tbody>
      </table>
    </Card>
  )
}

export function ClientTable() {
  const { data, error } = useSWR<ClientSummary[]>("/api/clients", fetcher)
  const searchParams = useSearchParams()
  const urlQuery = searchParams.get("q") ?? ""
  const [query, setQuery] = useState(urlQuery)
  const [filter, setFilter] = useState<StatusFilter>("all")

  // The topbar's global search lands on /clients?q=… — adopt it as it changes
  // (render-time state adjustment, per React's derived-state guidance).
  const [lastUrlQuery, setLastUrlQuery] = useState(urlQuery)
  if (urlQuery !== lastUrlQuery) {
    setLastUrlQuery(urlQuery)
    setQuery(urlQuery)
  }

  const searched = useMemo(() => {
    if (!data) return undefined
    const q = query.trim().toLowerCase()
    if (!q) return data
    return data.filter(
      c => c.businessName.toLowerCase().includes(q) || c.contactName.toLowerCase().includes(q),
    )
  }, [data, query])

  const counts = useMemo(() => {
    if (!searched) return undefined
    const byStatus = { all: searched.length, missing_docs: 0, in_review: 0, complete: 0 }
    for (const c of searched) byStatus[c.status] += 1
    return byStatus
  }, [searched])

  const rows = searched?.filter(c => filter === "all" || c.status === filter)

  if (error) {
    return (
      <Card>
        <ErrorState title="Couldn't load clients" />
      </Card>
    )
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <div className="relative w-64 max-w-full">
          <Search
            size={14}
            strokeWidth={1.75}
            className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-faint"
          />
          <input
            type="search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search business or contact…"
            aria-label="Search clients"
            className="h-8 w-full rounded-lg border border-line bg-surface pr-3 pl-8 text-[13px] text-ink placeholder:text-ink-faint focus:border-line-strong focus:bg-card focus:ring-2 focus:ring-line focus:outline-none"
          />
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by status">
          {FILTERS.map(f => {
            const active = filter === f.value
            return (
              <button
                key={f.value}
                type="button"
                aria-pressed={active}
                onClick={() => setFilter(f.value)}
                className={cn(
                  "flex h-7 items-center gap-1.5 rounded-full px-3 text-[12px] font-medium transition-colors",
                  active
                    ? "bg-ink text-white"
                    : "border border-line text-ink-soft hover:bg-surface hover:text-ink",
                )}
              >
                {f.label}
                {counts && (
                  <span className={cn("tabular-nums", active ? "text-white/60" : "text-ink-faint")}>
                    {counts[f.value]}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </div>
      {rows && rows.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No clients match"
          description="Try a different search or clear the status filter to see every client."
        />
      ) : (
        <table className="w-full">
          <thead>
            <HeaderRow />
          </thead>
          <tbody>
            {!rows ? <SkeletonRows /> : rows.map(c => <ClientRow key={c.id} client={c} />)}
          </tbody>
        </table>
      )}
    </Card>
  )
}
