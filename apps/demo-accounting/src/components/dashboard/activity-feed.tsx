"use client"

import {
  Activity,
  CalendarClock,
  FileCheck2,
  FileUp,
  FileX2,
  MessageSquare,
  type LucideIcon,
} from "lucide-react"
import useSWR from "swr"
import { Card, CardHeader } from "@/components/ui/card"
import { EmptyState } from "@/components/ui/empty-state"
import { Skeleton } from "@/components/ui/skeleton"
import { fetcher, type ActivityEvent } from "@/lib/api"
import { cn } from "@/lib/cn"
import { relativeTime } from "@/lib/format"
import type { ActivityType } from "@/server/types"

const EVENT_STYLE: Record<ActivityType, { icon: LucideIcon; chip: string }> = {
  upload_received: { icon: FileUp, chip: "bg-status-review-bg text-status-review" },
  document_verified: { icon: FileCheck2, chip: "bg-status-verified-bg text-status-verified" },
  document_rejected: { icon: FileX2, chip: "bg-status-overdue-bg text-status-overdue" },
  message_sent: { icon: MessageSquare, chip: "bg-evergreen-50 text-evergreen-600" },
  deadline_approaching: { icon: CalendarClock, chip: "bg-status-missing-bg text-status-missing" },
}

function ActivityRow({ event }: { event: ActivityEvent }) {
  const style = EVENT_STYLE[event.type]
  return (
    <li className="flex gap-3 px-5 py-3">
      <span
        className={cn(
          "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
          style.chip,
        )}
      >
        <style.icon size={13} strokeWidth={1.75} />
      </span>
      <div className="min-w-0">
        <p className="text-[12.5px] leading-snug">{event.summary}</p>
        <p className="mt-0.5 text-[11px] text-ink-faint">{relativeTime(event.at)}</p>
      </div>
    </li>
  )
}

export function ActivityFeed({ className }: { className?: string }) {
  const { data } = useSWR<ActivityEvent[]>("/api/activity?limit=8", fetcher)

  return (
    <Card className={cn("overflow-hidden", className)}>
      <CardHeader title="Recent activity" />
      {!data ? (
        <div className="space-y-4 px-5 pt-1 pb-5">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="flex gap-3">
              <Skeleton className="h-7 w-7 shrink-0 rounded-full" />
              <div className="flex-1">
                <Skeleton className="h-3.5 w-full" />
                <Skeleton className="mt-1.5 h-3 w-12" />
              </div>
            </div>
          ))}
        </div>
      ) : data.length === 0 ? (
        <EmptyState
          icon={Activity}
          title="No activity yet"
          description="Uploads, reviews, and messages across the firm will show up here."
        />
      ) : (
        <ul className="divide-y divide-line/60 border-t border-line/70">
          {data.map(event => (
            <ActivityRow key={event.id} event={event} />
          ))}
        </ul>
      )}
    </Card>
  )
}
