import { dashboardMetrics } from "@/server/documents"
import { ok } from "@/server/http"

export async function GET() {
  return ok(dashboardMetrics())
}
