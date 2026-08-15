/**
 * POST /api/customers/:id/notes — appends a dated, attributed line to the
 * customer's notes. A write, but an additive one: nothing is overwritten.
 */
import { appendCustomerNote } from "@/server/customers"
import { readParams } from "@/server/params"
import { resolveActor } from "@/server/actor"
import { ok, fail, badRequest, unauthorized } from "@/server/http"

export const dynamic = "force-dynamic"

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const args = await readParams(req)
  const actor = await resolveActor(req)
  if (!actor) return unauthorized()

  const note = args.get("note")
  if (!note) return badRequest("note is required.")

  try {
    const customer = appendCustomerNote(decodeURIComponent(id), note, actor.email)
    return ok(customer)
  } catch (err) {
    return fail(err)
  }
}
