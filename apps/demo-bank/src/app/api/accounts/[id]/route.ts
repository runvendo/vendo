import { getAccount } from "@/server/accounts"
import { ok, notFound } from "@/server/http"

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const a = getAccount(id)
  return a ? ok(a) : notFound("Account not found")
}
