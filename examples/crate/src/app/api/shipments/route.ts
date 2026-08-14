/**
 * GET  /api/shipments — tracking board. `problems_only=true` is the triage view:
 *      exceptions and returns, the only ones needing a human.
 * POST /api/shipments — hands a paid or fulfilled order to a carrier: creates
 *      the label, moves the order to shipped, and takes the units off the shelf.
 *      A write; the agent asks first.
 */
import { createShipment, listShipments } from "@/server/shipments"
import { readParams } from "@/server/params"
import { resolveActor } from "@/server/actor"
import { ok, created, fail, badRequest } from "@/server/http"

export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const params = await readParams(req)
  try {
    const shipments = listShipments({
      status: params.get("status"),
      problemsOnly: params.bool("problems_only"),
      limit: params.num("limit"),
    })
    return ok({ shipments, count: shipments.length })
  } catch (err) {
    return fail(err)
  }
}

export async function POST(req: Request) {
  const args = await readParams(req)
  const actor = await resolveActor(req)

  const orderId = args.get("order_id")
  if (!orderId) return badRequest("order_id is required.")

  try {
    const shipment = createShipment({
      orderId,
      carrier: args.get("carrier"),
      createdBy: actor.email,
    })
    return created(shipment)
  } catch (err) {
    return fail(err)
  }
}
