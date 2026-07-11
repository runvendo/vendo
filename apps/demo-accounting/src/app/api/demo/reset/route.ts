// POST /api/demo/reset — restore the seeded opening state between demo takes.
// Also recreates the Vendo automations world (standing automations are demo
// state too, and the chat route drops agents built against the dead world) and
// resets the Vendo consent state (ENG-193): the thread-id mapping is cleared
// and standing grants are revoked, so the next take replays the full
// approval-card choreography instead of silently inheriting last take's grants.
import { dashboardMetrics } from "@/server/documents"
import { ok } from "@/server/http"
import { resetStore } from "@/server/store"
import { resetDemoStore } from "@/vendo/store"

export const runtime = "nodejs"

export async function POST() {
  resetStore()
  await resetDemoStore()
  return ok(dashboardMetrics())
}
