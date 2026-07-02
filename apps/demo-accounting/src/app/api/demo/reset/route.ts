// POST /api/demo/reset — restore the seeded opening state between demo takes.
import { dashboardMetrics } from "@/server/documents"
import { ok } from "@/server/http"
import { resetStore } from "@/server/store"

export async function POST() {
  resetStore()
  return ok(dashboardMetrics())
}
