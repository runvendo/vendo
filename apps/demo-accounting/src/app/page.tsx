"use client"

import { useSyncExternalStore } from "react"
import { ActivityFeed } from "@/components/dashboard/activity-feed"
import { DeadlineList } from "@/components/dashboard/deadline-list"
import { StatRow } from "@/components/dashboard/stat-row"
import { FlowletCard } from "@/components/flowlet/flowlet-card"
import { PageHeader } from "@/components/ui/page-header"
import { Reveal } from "@/components/ui/reveal"

const noopSubscribe = () => () => {}

/**
 * Locale/timezone-dependent, so it must never render during SSR: the server
 * snapshot is empty and the real date fills in after hydration.
 */
function useTodayLabel(): string {
  return useSyncExternalStore(
    noopSubscribe,
    () => new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }),
    () => "",
  )
}

export default function DashboardPage() {
  const today = useTodayLabel()

  return (
    <div className="space-y-6">
      <Reveal delay={0}>
        <PageHeader
          title="Dashboard"
          description="Tax season at a glance for Hartwell & Associates"
          actions={<span className="text-[13px] text-ink-faint">{today}</span>}
        />
      </Reveal>
      <Reveal delay={0.05}>
        <StatRow />
      </Reveal>
      <Reveal delay={0.1}>
        <div className="grid grid-cols-3 items-start gap-4">
          <DeadlineList className="col-span-2" />
          <ActivityFeed />
        </div>
      </Reveal>
      {/* The droppable Flowlet slot: "put my generated UI here" (F5 surface #3). */}
      <Reveal delay={0.15}>
        <FlowletCard />
      </Reveal>
    </div>
  )
}
