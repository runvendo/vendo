/**
 * POST /api/products/:id/adjust-stock — corrects on-hand stock by a signed
 * delta (+12 received, -1 damaged) and records who and why. A write: the agent
 * asks before moving a number the warehouse counts on.
 */
import { adjustStock } from "@/server/inventory"
import { readParams } from "@/server/params"
import { resolveActor } from "@/server/actor"
import { ok, fail, badRequest } from "@/server/http"

export const dynamic = "force-dynamic"

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const args = await readParams(req)
  const actor = await resolveActor(req)

  const delta = args.num("delta")
  if (delta === undefined) return badRequest("delta is required (signed whole units).")

  try {
    const { product, adjustment } = adjustStock({
      productId: id,
      delta,
      reason: args.get("reason") ?? "",
      createdBy: actor.email,
    })
    return ok({ product, adjustment })
  } catch (err) {
    return fail(err)
  }
}
