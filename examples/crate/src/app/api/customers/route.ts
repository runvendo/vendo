/**
 * GET /api/customers — biggest spenders first; `q` matches name, email or phone.
 */
import { listCustomers } from "@/server/customers"
import { readParams } from "@/server/params"
import { ok, fail } from "@/server/http"

export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const params = await readParams(req)
  try {
    const customers = listCustomers({ q: params.get("q"), limit: params.num("limit") })
    return ok({ customers, count: customers.length })
  } catch (err) {
    return fail(err)
  }
}
