import { dashboardMetrics } from "@/server/documents"
import { ok } from "@/server/http"
import { getStore } from "@/server/store"

export async function GET() {
  const store = getStore()
  const metrics = dashboardMetrics()
  const nearest = metrics.nearestDeadline
    ? (store.clients.find(c => c.filingDeadline === metrics.nearestDeadline) ?? null)
    : null
  return ok({
    ...metrics,
    clientsTotal: store.clients.length,
    nearestDeadlineClient: nearest
      ? {
          id: nearest.id,
          businessName: nearest.businessName,
          filingDeadline: nearest.filingDeadline,
        }
      : null,
  })
}
