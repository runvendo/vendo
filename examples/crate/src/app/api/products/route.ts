/**
 * GET /api/products — the catalogue. `low_stock=true` narrows it to what is at
 * or under its reorder point, which is the question anyone actually asks.
 */
import { listProducts, availableUnits } from "@/server/inventory"
import { readParams } from "@/server/params"
import { ok, fail } from "@/server/http"

export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const params = await readParams(req)
  try {
    const products = listProducts({
      q: params.get("q"),
      category: params.get("category"),
      lowStock: params.bool("low_stock"),
      limit: params.num("limit"),
    })
    return ok({
      products: products.map((p) => ({ ...p, available: availableUnits(p) })),
      count: products.length,
    })
  } catch (err) {
    return fail(err)
  }
}
