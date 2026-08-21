/**
 * GET /api/shipments/:id — one shipment with its scan timeline, plus the order
 * and customer it belongs to. `:id` accepts the shipment id, the tracking
 * number, or the order id/number — all three arrive in real tickets.
 */
import { getShipmentDetail } from "@/server/shipments"
import { ok, fail } from "@/server/http"

export const dynamic = "force-dynamic"

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    return ok(getShipmentDetail(id))
  } catch (err) {
    return fail(err)
  }
}
