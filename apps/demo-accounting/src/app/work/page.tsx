"use client"

import Link from "next/link"
import { ArrowUpRight, CheckCircle2, ClipboardList, FileSearch, FileStack } from "lucide-react"
import useSWR from "swr"
import { Avatar } from "@/components/clients/meta"
import { BADGE_VARIANTS } from "@/components/ui/badge"
import { Card, CardHeader } from "@/components/ui/card"
import { EmptyState } from "@/components/ui/empty-state"
import { ErrorState } from "@/components/ui/error-state"
import { PageHeader } from "@/components/ui/page-header"
import { Reveal } from "@/components/ui/reveal"
import { Skeleton } from "@/components/ui/skeleton"
import { fetcher, type DeadlineEntry } from "@/lib/api"
import { daysUntil, formatDate } from "@/lib/format"

// Tasks are derived live from document state: every client with outstanding or
// unreviewed documents is one piece of work, ordered by filing deadline.
interface Task {
  client: DeadlineEntry
  title: string
  detail: string
  icon: typeof FileStack
  chip: string
}

function deriveTasks(entries: DeadlineEntry[]): Task[] {
  return entries.flatMap(client => {
    if (client.status === "missing_docs") {
      return [
        {
          client,
          title: "Collect missing documents",
          detail: `${client.businessName} · ${client.missingDocKinds.join(", ")}`,
          icon: FileStack,
          chip: BADGE_VARIANTS.missing,
        },
      ]
    }
    if (client.status === "in_review") {
      return [
        {
          client,
          title: "Review uploaded documents",
          detail: `${client.businessName} · all ${client.progress.total} documents in, awaiting review`,
          icon: FileSearch,
          chip: BADGE_VARIANTS.review,
        },
      ]
    }
    return []
  })
}

function TaskRow({ task }: { task: Task }) {
  const days = daysUntil(task.client.filingDeadline)
  return (
    <li>
      <Link
        href={`/clients/${task.client.id}`}
        className="group flex items-center gap-4 px-5 py-3.5 transition-colors hover:bg-surface/70"
      >
        <span
          className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${task.chip}`}
        >
          <task.icon size={13} strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-medium">{task.title}</p>
          <p className="mt-0.5 truncate text-[12px] text-ink-faint">{task.detail}</p>
        </div>
        {task.client.assignee && (
          <div className="flex w-40 shrink-0 items-center gap-2">
            <Avatar initials={task.client.assignee.initials} />
            <span className="truncate text-[12px] text-ink-soft">{task.client.assignee.name}</span>
          </div>
        )}
        <div className="w-28 shrink-0 text-right">
          <p className="text-[12px] text-ink-soft tabular-nums">
            {formatDate(task.client.filingDeadline)}
          </p>
          <p className="mt-0.5 text-[11px] text-ink-faint tabular-nums">
            {days < 0 ? `${-days}d overdue` : days === 0 ? "due today" : `in ${days} days`}
          </p>
        </div>
        <ArrowUpRight
          size={14}
          className="shrink-0 text-ink-faint opacity-0 transition-opacity group-hover:opacity-100"
        />
      </Link>
    </li>
  )
}

function WorkSkeleton() {
  return (
    <div className="space-y-4 border-t border-line/70 px-5 py-4">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="flex items-center gap-4">
          <Skeleton className="h-7 w-7 shrink-0 rounded-full" />
          <div className="flex-1">
            <Skeleton className="h-4 w-52" />
            <Skeleton className="mt-1.5 h-3 w-72" />
          </div>
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-3 w-20" />
        </div>
      ))}
    </div>
  )
}

export default function WorkPage() {
  const { data, error } = useSWR<DeadlineEntry[]>("/api/deadlines", fetcher)
  const tasks = data ? deriveTasks(data) : undefined

  return (
    <div className="space-y-6">
      <Reveal delay={0}>
        <PageHeader
          title="Work"
          description="Open document work across the firm, ordered by filing deadline"
        />
      </Reveal>
      <Reveal delay={0.05}>
        <Card className="overflow-hidden">
          <CardHeader
            title="Open tasks"
            action={
              tasks && (
                <span className="text-[12px] text-ink-faint tabular-nums">
                  {tasks.length} open · {(data?.length ?? 0) - tasks.length} complete
                </span>
              )
            }
          />
          {error ? (
            <ErrorState title="Couldn't load work items" />
          ) : !tasks ? (
            <WorkSkeleton />
          ) : tasks.length === 0 ? (
            <EmptyState
              icon={CheckCircle2}
              title="All caught up"
              description="Every client's documents are collected and reviewed. New uploads and requests will create work here."
            />
          ) : (
            <ul className="divide-y divide-line/60 border-t border-line/70">
              {tasks.map(task => (
                <TaskRow key={task.client.id} task={task} />
              ))}
            </ul>
          )}
        </Card>
      </Reveal>
      <Reveal delay={0.1}>
        <p className="flex items-center gap-2 text-[12px] text-ink-faint">
          <ClipboardList size={13} strokeWidth={1.75} />
          Tasks are generated from each client&apos;s document checklist and clear automatically as
          documents are verified.
        </p>
      </Reveal>
    </div>
  )
}
