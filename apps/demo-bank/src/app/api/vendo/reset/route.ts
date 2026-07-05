/**
 * POST /api/vendo/reset — return the demo to its pristine starting state.
 *
 * Re-seeds Maple deterministically (restoring the planted $87 charge, removing
 * any orders placed during a run), recreates the automations world, and
 * re-baselines the poller. The client reloads afterward to reset the thread.
 * One touch → the exact start line, every run.
 */
import { __reseed } from "@/server/store"
import { resetAutomations } from "@/vendo/automations"
import { resetPoller } from "@/vendo/poller"
import { resetConnections } from "@/vendo/connections-store"
import { ok } from "@/server/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST() {
  __reseed(new Date())
  resetAutomations()
  resetPoller()
  resetConnections()
  return ok({ reset: true })
}
