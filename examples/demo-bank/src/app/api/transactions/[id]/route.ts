import { getTransaction } from "@/server/transactions"
import { ok, notFound } from "@/server/http"

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const t = getTransaction(id)
  return t ? ok(t) : notFound("Transaction not found")
}
