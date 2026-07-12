// POST /api/demo/reset — restore the seeded opening state between demo takes.
import { dashboardMetrics } from "@/server/documents"
import { ok } from "@/server/http"
import { resetStore } from "@/server/store"

export const runtime = "nodejs"

export async function POST() {
  resetStore()
  // VENDO-MIGRATION: the v0 umbrella owns its persistent grants and threads;
  // the frozen wire has no demo-only reset operation.
  return ok(dashboardMetrics())
}
