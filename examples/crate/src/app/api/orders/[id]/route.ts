/**
 * GET /api/orders/:id — one order with everything hanging off it: customer,
 * shipping address, shipment, refunds. `:id` accepts the internal id or the
 * human order number ("CR-1084"), which is what people actually quote.
 */
import { getOrderDetail } from "@/server/orders"
import { ok, fail } from "@/server/http"

export const dynamic = "force-dynamic"

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    return ok(getOrderDetail(id))
  } catch (err) {
    return fail(err)
  }
}
