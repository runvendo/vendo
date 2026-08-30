/**
 * GET /api/orders — the console's home query, and the agent's most-used tool.
 * Filters: status, customer_id, q (order number / customer name / email), limit.
 */
import { listOrders } from "@/server/orders"
import { readParams } from "@/server/params"
import { ok, fail } from "@/server/http"

export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const params = await readParams(req)
  try {
    const orders = listOrders({
      status: params.get("status"),
      customerId: params.get("customer_id"),
      q: params.get("q"),
      limit: params.num("limit"),
    })
    return ok({ orders, count: orders.length })
  } catch (err) {
    return fail(err)
  }
}
