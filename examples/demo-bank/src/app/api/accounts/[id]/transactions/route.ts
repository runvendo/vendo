import { getAccountTransactions } from "@/server/accounts"
import { ok } from "@/server/http"

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const u = new URL(req.url)
  const bound = (k: string) => u.searchParams.get(k) ?? undefined
  return ok(getAccountTransactions(id, 50, { from: bound("from"), to: bound("to") }))
}
