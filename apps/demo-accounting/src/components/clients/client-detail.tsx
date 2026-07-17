"use client"

import Link from "next/link"
import { ArrowLeft, SearchX } from "lucide-react"
import useSWR from "swr"
import { ClientMark } from "@/components/clients/client-marks"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { EmptyState } from "@/components/ui/empty-state"
import { ErrorState } from "@/components/ui/error-state"
import { ProgressBar } from "@/components/ui/progress"
import { Reveal } from "@/components/ui/reveal"
import { Skeleton } from "@/components/ui/skeleton"
import { ApiError, fetcher, type ClientSummary } from "@/lib/api"
import { daysUntil, entityLabel, formatDate } from "@/lib/format"
import { ClientPanel } from "./client-panel"
import { DocumentChecklist } from "./document-checklist"
import { MessageThread } from "./message-thread"
import { CLIENT_STATUS_META, deadlineUrgency } from "./meta"

function BackLink() {
  return (
    <Link
      href="/clients"
      className="inline-flex items-center gap-1.5 text-[12px] font-medium text-ink-faint transition-colors hover:text-ink"
    >
      <ArrowLeft size={13} strokeWidth={1.75} />
      All clients
    </Link>
  )
}

function DetailSkeleton() {
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <BackLink />
        <div className="flex items-end justify-between">
          <div>
            <Skeleton className="h-7 w-72" />
            <Skeleton className="mt-2.5 h-4 w-56" />
          </div>
          <div className="flex items-center gap-8">
            <Skeleton className="h-10 w-32" />
            <Skeleton className="h-10 w-44" />
          </div>
        </div>
      </div>
      <div className="grid grid-cols-3 items-start gap-4">
        <div className="col-span-2 space-y-4">
          <Skeleton className="h-72 rounded-xl" />
          <Skeleton className="h-64 rounded-xl" />
        </div>
        <Skeleton className="h-96 rounded-xl" />
      </div>
    </div>
  )
}

function NotFoundState({ id }: { id: string }) {
  return (
    <div className="space-y-4">
      <BackLink />
      <Card>
        <EmptyState
          icon={SearchX}
          title="Client not found"
          description={`There's no client "${id}" — it may have been removed, or the link is stale.`}
          action={
            <Link
              href="/clients"
              className="inline-flex h-8 items-center rounded-md bg-ink px-3 text-[12.5px] font-medium text-white transition-colors hover:bg-ink-soft"
            >
              Back to clients
            </Link>
          }
          className="py-16"
        />
      </Card>
    </div>
  )
}

export function ClientDetail({ id }: { id: string }) {
  const { data: client, error } = useSWR<ClientSummary>(`/api/clients/${id}`, fetcher)

  if (error instanceof ApiError && error.status === 404) return <NotFoundState id={id} />
  if (error) {
    return (
      <div className="space-y-4">
        <BackLink />
        <Card>
          <ErrorState title="Couldn't load this client" />
        </Card>
      </div>
    )
  }
  if (!client) return <DetailSkeleton />

  const urgency = deadlineUrgency(daysUntil(client.filingDeadline))
  const status = CLIENT_STATUS_META[client.status]

  return (
    <div className="space-y-6">
      <Reveal delay={0}>
        <div className="space-y-3">
          <BackLink />
          <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
            <div className="flex min-w-0 items-center gap-3.5">
              <ClientMark clientId={client.id} name={client.businessName} size={44} />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2.5">
                  <h1 className="text-[22px] font-semibold tracking-tight">{client.businessName}</h1>
                  <Badge>{entityLabel(client.entityType)}</Badge>
                  <Badge variant={status.variant} dot>
                    {status.label}
                  </Badge>
                </div>
                <p className="mt-1 text-[13.5px] text-ink-soft">
                  {client.contactName} · {client.contactEmail}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-8">
              <div>
                <p className="text-[11px] font-medium text-ink-faint">Filing deadline</p>
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-[13.5px] font-medium tabular-nums">
                    {formatDate(client.filingDeadline)}
                  </span>
                  <Badge variant={urgency.variant} className="tabular-nums">
                    {urgency.label}
                  </Badge>
                </div>
              </div>
              <div className="w-44">
                <div className="flex items-center justify-between text-[11px] font-medium text-ink-faint tabular-nums">
                  <span>Documents</span>
                  <span>
                    {client.progress.received} of {client.progress.total}
                  </span>
                </div>
                <ProgressBar value={client.progress.received} max={client.progress.total} className="mt-1.5" />
              </div>
            </div>
          </div>
        </div>
      </Reveal>
      <Reveal delay={0.05}>
        <div className="grid grid-cols-3 items-start gap-4">
          <div className="col-span-2 space-y-4">
            <DocumentChecklist clientId={id} />
            <MessageThread clientId={id} contactName={client.contactName} />
          </div>
          <ClientPanel client={client} />
        </div>
      </Reveal>
    </div>
  )
}
