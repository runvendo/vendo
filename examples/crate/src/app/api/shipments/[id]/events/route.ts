/**
 * POST /api/shipments/:id/events — records a carrier scan. The shipment's own
 * status follows the newest event, and a `delivered` scan closes out the order.
 */
import { addShipmentEvent } from "@/server/shipments"
import { readParams } from "@/server/params"
import { ok, fail, badRequest } from "@/server/http"

export const dynamic = "force-dynamic"

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const args = await readParams(req)

  const status = args.get("status")
  if (!status) return badRequest("status is required.")

  try {
    const shipment = addShipmentEvent({
      shipmentId: id,
      status,
      location: args.get("location"),
      detail: args.get("detail"),
    })
    return ok(shipment)
  } catch (err) {
    return fail(err)
  }
}
