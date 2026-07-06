/**
 * POST /api/transfers — Maple's irreversible write. Sends money to a person,
 * debiting checking and appending a posted transfer. The Vendo agent only
 * reaches this after the CRITICAL ceremony consent card (Amount, Recipient) is
 * confirmed; params arrive as query string (the host-tool runner's shape for
 * declared query parameters). Moves in-memory demo funds only — no real money.
 */
import { transferMoney } from "@/server/transfers"
import { ok } from "@/server/http"

export const dynamic = "force-dynamic"

export async function POST(req: Request) {
  const url = new URL(req.url)
  const amountRaw = url.searchParams.get("amount")
  const txn = transferMoney({
    amount: amountRaw != null ? Number(amountRaw) : undefined,
    recipientName: url.searchParams.get("recipient_name") ?? undefined,
    memo: url.searchParams.get("memo") ?? undefined,
  })
  return ok(txn)
}
