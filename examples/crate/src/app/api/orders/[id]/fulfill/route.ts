/**
 * POST /api/orders/:id/fulfill — marks a paid order picked and packed. Nothing
 * has left the building yet; that's POST /api/shipments.
 */
import { fulfillOrder } from "@/server/orders"
import { resolveActor } from "@/server/actor"
import { ok, fail } from "@/server/http"

export const dynamic = "force-dynamic"

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const actor = await resolveActor(req)
  try {
    const order = fulfillOrder(id)
    return ok({ order, actor: { id: actor.id, email: actor.email } })
  } catch (err) {
    return fail(err)
  }
}
