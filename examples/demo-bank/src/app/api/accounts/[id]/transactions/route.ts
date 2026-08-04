import { getAccountTransactions } from "@/server/accounts"
import { ok } from "@/server/http"

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return ok(getAccountTransactions(id))
}
