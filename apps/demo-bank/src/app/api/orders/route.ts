/**
 * POST /api/orders — Maple's one write. Places a late-night delivery order,
 * appending a transaction. The order page calls this; the Flowlet poller then
 * discovers the new row via the existing /api/transactions read API.
 */
import { placeOrder, type PlaceOrderInput } from "@/server/orders"
import { ok } from "@/server/http"

export const dynamic = "force-dynamic"

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as PlaceOrderInput
  const txn = placeOrder(body)
  return ok(txn)
}
