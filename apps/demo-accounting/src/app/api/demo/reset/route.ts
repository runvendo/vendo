// POST /api/demo/reset — restore the seeded opening state between demo takes.
// Also recreates the Flowlet automations world (standing automations are demo
// state too, and the chat route drops agents built against the dead world) and
// resets the Flowlet consent state (ENG-193): the thread-id mapping is cleared
// and standing grants are revoked, so the next take replays the full
// approval-card choreography instead of silently inheriting last take's grants.
import { dashboardMetrics } from "@/server/documents"
import { ok } from "@/server/http"
import { resetStore } from "@/server/store"
import { resetAutomations } from "@/flowlet/automations"
import { resetDemoStore } from "@/flowlet/store"

export const runtime = "nodejs"

export async function POST() {
  resetStore()
  resetAutomations()
  await resetDemoStore()
  return ok(dashboardMetrics())
}
