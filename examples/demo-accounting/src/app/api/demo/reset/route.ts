// POST /api/demo/reset — restore the seeded opening state between demo takes.
import { dashboardMetrics } from "@/server/documents"
import { ok } from "@/server/http"
import { resetStore } from "@/server/store"
import { cadenceDemoUsers } from "@/server/users"
import { seedDemoScript } from "@/demo-script/seed"
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
  // Scripted demo: re-seed the rehearsal automations so a mid-demo reset
  // restores any the presenter deleted. Insert-if-absent, so an automation
  // that survived (and any edit to it) is left exactly as it was.
  //
  // Fire-and-forget, unlike demo-bank's awaited call: Maple erases each
  // subject's Vendo state on reset and so MUST re-seed before answering, but
  // Cadence's reset leaves that state alone — nothing here is urgent enough
  // to hold the response behind a store schema check.
  seedDemoScript().catch((error: unknown) => {
    console.error("[cadence] automation re-seed failed:", error)
  })
  // Chip cache repair, fire-and-forget (a reset must answer fast —
  // generation takes minutes). Idempotent: intact cached apps are skipped.
  pregenerateChips().catch((error: unknown) => {
    console.error("[cadence] chip pre-generation failed:", error)
  })
  // VENDO-MIGRATION: the v0 umbrella owns its persistent grants and threads;
  // the frozen wire has no demo-only reset operation.
  return ok(dashboardMetrics())
}
