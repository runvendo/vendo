// POST /api/demo/reset — restore the seeded opening state between demo takes.
// Also recreates the Flowlet automations world: standing automations are demo
// state too, and the chat route drops agents built against the dead world.
import { dashboardMetrics } from "@/server/documents"
import { ok } from "@/server/http"
import { resetStore } from "@/server/store"
import { resetAutomations } from "@/flowlet/automations"

export const runtime = "nodejs"

export async function POST() {
  resetStore()
  resetAutomations()
  return ok(dashboardMetrics())
}
