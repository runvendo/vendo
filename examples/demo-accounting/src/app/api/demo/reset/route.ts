// POST /api/demo/reset — restore the seeded opening state between demo takes.
import { dashboardMetrics } from "@/server/documents"
import { ok } from "@/server/http"
import { resetStore } from "@/server/store"
import { cadenceDemoUsers } from "@/server/users"
import { pregenerateChips } from "@/vendo/chips-seed"
import { sweepDemoConnections } from "@/vendo/reset-connections"
import { vendo } from "@/vendo/server"

export const runtime = "nodejs"

export async function POST() {
  resetStore()
  // Demo-hygiene: connected accounts live broker-side and survive both the
  // store reseed and redeploys — sweep them so reset returns connections to
  // out-of-the-box too.
  await sweepDemoConnections(vendo.connections, cadenceDemoUsers())
  // Chip cache repair, fire-and-forget (a reset must answer fast —
  // generation takes minutes). Idempotent: intact cached apps are skipped.
  pregenerateChips().catch((error: unknown) => {
    console.error("[cadence] chip pre-generation failed:", error)
  })
  // VENDO-MIGRATION: the v0 umbrella owns its persistent grants and threads;
  // the frozen wire has no demo-only reset operation.
  return ok(dashboardMetrics())
}
