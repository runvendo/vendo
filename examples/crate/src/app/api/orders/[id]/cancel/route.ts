/**
 * POST /api/orders/:id/cancel — stops an order that has not shipped, releases
 * its reserved stock, and drops it out of the customer's lifetime value.
 * Destructive: the agent asks first. Anything already shipped is refused with
 * the reason, so the agent can offer a refund instead of guessing.
 */
import { cancelOrder } from "@/server/orders"
import { readParams } from "@/server/params"
import { resolveActor } from "@/server/actor"
import { ok, fail, unauthorized } from "@/server/http"

export const dynamic = "force-dynamic"

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const args = await readParams(req)
  const actor = await resolveActor(req)
  if (!actor) return unauthorized()
  try {
    const order = cancelOrder(id, args.get("reason"))
    return ok({ order, actor: { id: actor.id, email: actor.email } })
  } catch (err) {
    return fail(err)
  }
}
