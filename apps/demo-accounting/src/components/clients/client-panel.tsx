"use client"

import { Mail } from "lucide-react"
import useSWR from "swr"
import { Badge } from "@/components/ui/badge"
import { Card, CardHeader } from "@/components/ui/card"
import { ProgressBar } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { fetcher, type ActivityEvent, type ClientSummary } from "@/lib/api"
import { daysUntil, entityLabel, formatDate, relativeTime } from "@/lib/format"
import { Avatar, deadlineUrgency } from "./meta"

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="px-5 py-3">
      <dt className="text-[11px] font-medium text-ink-faint">{label}</dt>
      <dd className="mt-1">{children}</dd>
    </div>
  )
}

function ClientActivity({ clientId }: { clientId: string }) {
  const { data, error } = useSWR<ActivityEvent[]>("/api/activity", fetcher)
  const events = data?.filter(e => e.clientId === clientId).slice(0, 6)

  return (
    <Card className="overflow-hidden">
      <CardHeader title="Recent activity" />
      {error ? (
        <p className="border-t border-line/70 px-5 py-4 text-[12px] text-ink-faint">
          Couldn&apos;t load activity.
        </p>
      ) : !events ? (
        <div className="space-y-4 border-t border-line/70 px-5 py-4">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i}>
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="mt-1.5 h-3 w-12" />
            </div>
          ))}
        </div>
      ) : events.length === 0 ? (
        <p className="border-t border-line/70 px-5 py-4 text-[12px] text-ink-faint">
          Nothing yet for this client.
        </p>
      ) : (
        <ul className="divide-y divide-line/60 border-t border-line/70">
          {events.map(e => (
            <li key={e.id} className="px-5 py-2.5">
              <p className="text-[12px] leading-snug">{e.summary}</p>
              <p className="mt-0.5 text-[11px] text-ink-faint">{relativeTime(e.at)}</p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

export function ClientPanel({ client }: { client: ClientSummary }) {
  const urgency = deadlineUrgency(daysUntil(client.filingDeadline))

  return (
    <div className="space-y-4">
      <Card className="overflow-hidden">
        <CardHeader title="Client details" />
        <dl className="divide-y divide-line/60 border-t border-line/70">
          <Field label="Contact">
            <p className="text-[13px] font-medium">{client.contactName}</p>
            <a
              href={`mailto:${client.contactEmail}`}
              className="mt-0.5 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-ink underline-offset-2 transition-colors hover:underline"
            >
              <Mail size={12} strokeWidth={1.75} />
              {client.contactEmail}
            </a>
          </Field>
          <Field label="Assignee">
            {client.assignee ? (
              <div className="flex items-center gap-2.5">
                <Avatar initials={client.assignee.initials} className="h-7 w-7 text-[11px]" />
                <div>
                  <p className="text-[13px] font-medium">{client.assignee.name}</p>
                  <p className="text-[11px] text-ink-faint">{client.assignee.role}</p>
                </div>
              </div>
            ) : (
              <p className="text-[13px] text-ink-faint">Unassigned</p>
            )}
          </Field>
          <Field label="Entity type">
            <Badge>{entityLabel(client.entityType)}</Badge>
          </Field>
          <Field label="Filing deadline">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-medium tabular-nums">
                {formatDate(client.filingDeadline)}
              </span>
              <Badge variant={urgency.variant} className="tabular-nums">
                {urgency.label}
              </Badge>
            </div>
          </Field>
          <Field label="Documents">
            <p className="text-[12px] text-ink-soft tabular-nums">
              {client.progress.received} of {client.progress.total} received
            </p>
            <ProgressBar value={client.progress.received} max={client.progress.total} className="mt-1.5" />
          </Field>
        </dl>
      </Card>
      <ClientActivity clientId={client.id} />
    </div>
  )
}
