/**
 * GET  /api/refunds — every refund, newest first; `order_id` narrows to one order.
 * POST /api/refunds — Crate's irreversible write: real money goes back to the
 *      customer. Omit `amount_cents` to refund everything still outstanding.
 *      This is the route the consent ceremony exists for — the agent must have
 *      an explicit confirmation before it ever gets here.
 */
import { createRefund, listRefunds, refundableCents } from "@/server/refunds"
import { readParams } from "@/server/params"
import { resolveActor } from "@/server/actor"
import { ok, created, fail, badRequest, unauthorized, forbidden } from "@/server/http"

export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const params = await readParams(req)
  try {
    const refunds = listRefunds({
      orderId: params.get("order_id"),
      limit: params.num("limit"),
    })
    return ok({ refunds, count: refunds.length })
  } catch (err) {
    return fail(err)
  }
}

export async function POST(req: Request) {
  const args = await readParams(req)
  const actor = await resolveActor(req)
  if (!actor) return unauthorized()
  // The one place a role decides anything: money only goes back on an owner's
  // say-so. Checked here rather than in the domain so the rule stays a
  // deployment decision, not a fact about refunds.
  if (actor.role !== "admin") {
    return forbidden("Only the shop owner can issue refunds. Ask them to approve this one.")
  }

  const orderId = args.get("order_id")
  if (!orderId) return badRequest("order_id is required.")
  const reason = args.get("reason")
  if (!reason) return badRequest("reason is required.")

  try {
    const refund = createRefund({
      orderId,
      amountCents: args.num("amount_cents"),
      reason,
      note: args.get("note"),
      createdBy: actor.email,
    })
    // Say what is left, so a partial refund doesn't need a second round-trip to
    // answer "and how much is still owed?".
    return created({ refund, remainingRefundableCents: refundableCents(orderId) })
  } catch (err) {
    return fail(err)
  }
}
