// POST /api/demo/reset — restore the seeded opening state between demo takes.
// It also resets Vendo consent state: the thread-id mapping is cleared and
// standing grants/rules are revoked, so a new take starts from a clean slate.
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
