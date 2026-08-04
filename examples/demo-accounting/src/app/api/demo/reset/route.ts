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
  // BOUNDED-await, not unbounded: reset completion should be meaningful — a
  // presenter who reopens the panel the instant reset returns should find the
  // scripted automations (and their Rehearse controls) already back — so we
  // wait for the seed rather than firing it and forgetting. But the seed writes
  // through the shared PGlite writer lock, and if ANOTHER Cadence process holds
  // it, an unbounded await would join that lock-wait and the reset response
  // would hang indefinitely. Capping the wait keeps reset responsive: the seed
  // is a handful of insert-if-absent writes and normally lands well within the
  // budget, so the common uncontended path still returns with the panel
  // repopulated; only a genuinely contended writer falls through to the
  // background, where the seed keeps running (its .catch swallows any late
  // failure) and re-lands on the next reset or the lock holder's boot seed. A
  // seed failure is logged, never fatal to the reset itself.
  const SEED_BUDGET_MS = 3_000
  const seeded = seedDemoScript()
  seeded.catch((error: unknown) => {
    console.error("[cadence] automation re-seed failed:", error)
  })
  let seedTimer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    seeded.catch(() => undefined),
    new Promise<void>((resolve) => {
      seedTimer = setTimeout(resolve, SEED_BUDGET_MS)
    }),
  ])
  if (seedTimer !== undefined) clearTimeout(seedTimer)
  // Chip cache repair, fire-and-forget (a reset must answer fast —
  // generation takes minutes). Idempotent: intact cached apps are skipped.
  pregenerateChips().catch((error: unknown) => {
    console.error("[cadence] chip pre-generation failed:", error)
  })
  // VENDO-MIGRATION: the v0 umbrella owns its persistent grants and threads;
  // the frozen wire has no demo-only reset operation.
  return ok(dashboardMetrics())
}
