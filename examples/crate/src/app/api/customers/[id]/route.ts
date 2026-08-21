/**
 * GET /api/customers/:id — the support view: profile, addresses, every order
 * newest first, and any refunds against them. `:id` accepts the id or the email,
 * because an email is what arrives in the ticket.
 */
import { getCustomerDetail } from "@/server/customers"
import { ok, fail } from "@/server/http"

export const dynamic = "force-dynamic"

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    return ok(getCustomerDetail(decodeURIComponent(id)))
  } catch (err) {
    return fail(err)
  }
}
