/**
 * GET /api/products/:id — one product with availability and its adjustment
 * history. `:id` accepts the id or the SKU quoted on a purchase order.
 */
import { getProductDetail } from "@/server/inventory"
import { ok, fail } from "@/server/http"

export const dynamic = "force-dynamic"

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    return ok(getProductDetail(id))
  } catch (err) {
    return fail(err)
  }
}
