/**
 * Scripted-demo seeding for Cadence — idempotent. Runs at server boot
 * (instrumentation.ts) and again after /api/demo/reset, so the automations
 * panel is never empty when a rehearsal demo starts.
 *
 * The documents themselves live in ./automations (import-cheap, unit-tested);
 * this module owns only the store write. All three are seeded DISABLED:
 * rehearsal is the pre-enable confidence step, so disabled is precisely the
 * state the demo should open in. Existing rows are left untouched, so seeding
 * is safe to run on every boot.
 */
import { cadenceDemoUsers } from "@/server/users"
import { vendo } from "@/vendo/server"
import { cadenceDemoAutomations } from "./automations"

export type DemoSeedStatus = "pending" | "restored" | "failed"

// The LATEST seed attempt's durable status. The reset response answers within
// a bounded budget, so a contended seed can still be landing (or can have
// failed) after the response already returned — this is the positive
// completion signal GET /api/demo/seed-status serves so a surface polls a
// fact, not a timer, before claiming "Seed restored". Concurrent attempts
// (boot + reset) write the same insert-if-absent rows, so last-writer-wins is
// convergent here.
let seedStatus: DemoSeedStatus = "pending"

/** Durable status of the latest `seedDemoScript` attempt. */
export function demoSeedStatus(): DemoSeedStatus {
  return seedStatus
}

/** Insert-if-absent the scripted-demo automations for every seeded Cadence
 *  user. Store-agnostic on purpose: writes ride the PUBLIC records door
 *  (`store.records("vendo_apps")` — the reserved-collection routing every
 *  VendoStore implements), so seeding behaves identically on the local PGlite
 *  store and the Cloud hosted store. */
export async function seedDemoScript(): Promise<void> {
  seedStatus = "pending"
  try {
    await vendo.store.ensureSchema()
    const apps = vendo.store.records("vendo_apps")
    for (const user of cadenceDemoUsers()) {
      for (const doc of cadenceDemoAutomations(user.subject)) {
        const existing = await apps.get(doc.id)
        if (existing !== null) continue // never clobber a recorded edit
        await apps.put({ id: doc.id, data: { subject: user.subject, enabled: false, doc } })
      }
    }
    seedStatus = "restored"
  } catch (error) {
    // A rejected seed is SETTLED, not pending — report it as the failure it
    // is (the caller decides whether to log/rethrow) so no poller waits out a
    // seed that will never land.
    seedStatus = "failed"
    throw error
  }
}

export { demoAppId } from "./automations"
