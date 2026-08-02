import { listTransactions, type TxQuery } from "@/server/transactions"
import { ok } from "@/server/http"
import type { Category, TxStatus } from "@/server/types"

export async function GET(req: Request) {
  const u = new URL(req.url)
  const num = (k: string) => { const v = u.searchParams.get(k); return v == null ? undefined : Number(v) }
  const q: TxQuery = {
    search: u.searchParams.get("search") ?? undefined,
    category: (u.searchParams.get("category") as Category) ?? undefined,
    accountId: u.searchParams.get("accountId") ?? undefined,
    status: (u.searchParams.get("status") as TxStatus) ?? undefined,
    from: u.searchParams.get("from") ?? undefined,
    to: u.searchParams.get("to") ?? undefined,
    min: num("min"), max: num("max"),
    sort: (u.searchParams.get("sort") as TxQuery["sort"]) ?? undefined,
    limit: num("limit"), cursor: u.searchParams.get("cursor") ?? undefined,
  }
  return ok(listTransactions(q))
}
