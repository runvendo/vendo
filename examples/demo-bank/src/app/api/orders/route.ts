/** POST /api/orders places a late-night delivery order and appends its transaction. */
import { placeOrder, type PlaceOrderInput } from "@/server/orders"
import { ok } from "@/server/http"

export const dynamic = "force-dynamic"

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as PlaceOrderInput
  const txn = placeOrder(body)
  return ok(txn)
}
