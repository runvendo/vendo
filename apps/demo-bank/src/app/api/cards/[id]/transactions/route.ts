import { getCardTransactions } from "@/server/cards"
import { ok } from "@/server/http"

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return ok(getCardTransactions(id))
}
