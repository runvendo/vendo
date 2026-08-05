// POST /api/demo/reset — restore the seeded opening state between demo takes.
import { NextResponse } from "next/server"
import { dashboardMetrics } from "@/server/documents"
import { resetStore } from "@/server/store"
import { cadenceDemoUsers } from "@/server/users"
import { demoSeedStatus, seedDemoScript } from "@/demo-script/seed"
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
  // background, where the seed keeps running (its handler swallows any late
  // failure) and re-lands on the next reset or the lock holder's boot seed. A
  // seed failure is logged, never fatal to the reset itself.
  //
  // EXPLICIT STATUS RESPONSE: when the seed falls through to the background,
  // the reset is only PARTIALLY done — the scripted automations are not in the
  // store yet — and a seed that REJECTED will never land them at all.
  // Reporting a flat success either way would make the panel claim "Seed
  // restored" over an empty automations list. So the response carries
  // `seedStatus` ("restored" | "pending" | "failed" — the durable status the
  // seed module tracks, also served by GET /api/demo/seed-status for pollers),
  // a sibling of the metrics `data` (which stays the exact DashboardMetrics
  // shape the dashboard returns — the ENG-202 contract). A pending client
  // re-polls the durable status until the background seed settles; a failed
  // one says so instead of claiming success.
  const SEED_BUDGET_MS = 3_000
  const seeded = seedDemoScript()
  // Log the failure and swallow the rejection (also after the race times out —
  // an unhandled rejection must not surface later). The failed status itself
  // is tracked durably by the seed module; it re-lands on the next reset or
  // the lock holder's boot seed, and the reset itself still succeeds.
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
  return NextResponse.json({ data: dashboardMetrics(), seedStatus: demoSeedStatus() })
}
