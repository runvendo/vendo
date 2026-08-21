/**
 * GET /api/metrics/summary — the shop's health in one call: orders and revenue
 * over the last 7 days, plus the three backlogs (unfulfilled, shipment
 * problems, low stock). Cheaper for the agent than reconstructing it from lists.
 */
import { dashboardSummary, needsAttention } from "@/server/metrics"
import { ok } from "@/server/http"

export const dynamic = "force-dynamic"

export async function GET() {
  return ok({ summary: dashboardSummary(), attention: needsAttention() })
}
