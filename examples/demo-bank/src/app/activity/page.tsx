"use client"
import { ActivityFeed } from "@/components/activity/activity-feed"

export default function ActivityPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">Activity</h1>
        <p className="text-sm text-muted">Deposits, card use, and security alerts.</p>
      </div>

      <ActivityFeed />
    </div>
  )
}
