/**
 * POST /api/flowlet/reset — return the demo to its pristine starting state.
 *
 * Re-seeds Maple deterministically (restoring the planted $87 charge, removing
 * any orders placed during a run), clears active rules, and re-baselines the
 * poller. The client reloads afterward to reset the thread. One touch → the
 * exact start line, every run.
 */
import { __reseed } from "@/server/store"
import { clearRules } from "@/flowlet/rules-store"
import { resetPoller } from "@/flowlet/poller"
import { resetConnections } from "@/flowlet/connections-store"
import { ok } from "@/server/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST() {
  __reseed(new Date())
  clearRules()
  resetPoller()
  resetConnections()
  return ok({ reset: true })
}
