"use client"

import Link from "next/link"
import { ArrowUpRight, FileUp, Inbox } from "lucide-react"
import useSWR from "swr"
import { BADGE_VARIANTS } from "@/components/ui/badge"
import { Card, CardHeader } from "@/components/ui/card"
import { EmptyState } from "@/components/ui/empty-state"
import { ErrorState } from "@/components/ui/error-state"
import { PageHeader } from "@/components/ui/page-header"
import { Reveal } from "@/components/ui/reveal"
import { Skeleton } from "@/components/ui/skeleton"
import { fetcher, type ActivityEvent } from "@/lib/api"
import { cn } from "@/lib/cn"
import { relativeTime } from "@/lib/format"

/** "Marisol Rivera uploaded W-2 (rivera-w2.pdf) — flagged" -> mono file name. */
function UploadSummary({ summary }: { summary: string }) {
  const match = summary.match(/^(.*)\(([^)]+)\)(.*)$/)
  if (!match) return <>{summary}</>
  const [, before, file, after] = match
  return (
    <>
      {before.trimEnd()}{" "}
      <span className="font-mono text-[11.5px] text-ink-soft">{file}</span>
      {after}
    </>
  )
}

function UploadRow({ event }: { event: ActivityEvent }) {
  const flagged = event.summary.includes("flagged for review")
  const row = (
    <>
      <span
        className={cn(
          "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
          flagged ? BADGE_VARIANTS.review : "bg-evergreen-50 text-evergreen-600",
        )}
      >
        <FileUp size={13} strokeWidth={1.75} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] leading-snug">
          <UploadSummary summary={event.summary} />
        </p>
        <p className="mt-0.5 text-[11px] text-ink-faint">{relativeTime(event.at)}</p>
      </div>
      {event.clientId && (
        <ArrowUpRight
          size={14}
          className="shrink-0 text-ink-faint opacity-0 transition-opacity group-hover:opacity-100"
        />
      )}
    </>
  )
  return (
    <li>
      {event.clientId ? (
        <Link
          href={`/clients/${event.clientId}`}
          className="group flex items-center gap-3 px-5 py-3.5 transition-colors hover:bg-surface/70"
        >
          {row}
        </Link>
      ) : (
        <div className="flex items-center gap-3 px-5 py-3.5">{row}</div>
      )}
    </li>
  )
}

function InboxSkeleton() {
  return (
    <div className="space-y-4 border-t border-line/70 px-5 py-4">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-7 w-7 shrink-0 rounded-full" />
          <div className="flex-1">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="mt-1.5 h-3 w-16" />
          </div>
        </div>
      ))}
    </div>
  )
}

export default function InboxPage() {
  const { data, error } = useSWR<ActivityEvent[]>("/api/activity", fetcher)
  const uploads = data?.filter(e => e.type === "upload_received")

  return (
    <div className="space-y-6">
      <Reveal delay={0}>
        <PageHeader
          title="Inbox"
          description="Client uploads as they arrive, newest first"
        />
      </Reveal>
      <Reveal delay={0.05}>
        <Card className="overflow-hidden">
          <CardHeader
            title="Incoming documents"
            action={
              uploads && (
                <span className="text-[12px] text-ink-faint tabular-nums">
                  {uploads.length} recent {uploads.length === 1 ? "upload" : "uploads"}
                </span>
              )
            }
          />
          {error ? (
            <ErrorState title="Couldn't load the document inbox" />
          ) : !uploads ? (
            <InboxSkeleton />
          ) : uploads.length === 0 ? (
            <EmptyState
              icon={Inbox}
              title="No uploads yet"
              description="When clients send documents through their portal, they land here for review."
            />
          ) : (
            <ul className="divide-y divide-line/60 border-t border-line/70">
              {uploads.map(event => (
                <UploadRow key={event.id} event={event} />
              ))}
            </ul>
          )}
        </Card>
      </Reveal>
    </div>
  )
}
