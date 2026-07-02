"use client"

import { motion } from "framer-motion"
import { ActivityFeed } from "@/components/dashboard/activity-feed"
import { DeadlineList } from "@/components/dashboard/deadline-list"
import { StatRow } from "@/components/dashboard/stat-row"
import { PageHeader } from "@/components/ui/page-header"

function Reveal({ delay, children }: { delay: number; children: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay, ease: "easeOut" }}
    >
      {children}
    </motion.div>
  )
}

export default function DashboardPage() {
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  })

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
    </div>
  )
}
