/**
 * POST /api/transfers — Maple's irreversible write. Sends money to a person,
 * debiting checking and appending a posted transfer. The Vendo agent only
 * reaches this after the CRITICAL ceremony consent card (Amount, Recipient) is
 * confirmed; params arrive as query string (the host-tool runner's shape for
 * declared query parameters). Moves in-memory demo funds only — no real money.
 */
import { transferMoney, TransferError } from "@/server/transfers"
import { ok, badRequest } from "@/server/http"
import { resolveMapleSession } from "@/vendo/auth"

export const dynamic = "force-dynamic"

export async function POST(req: Request) {
  const url = new URL(req.url)
  const amountRaw = url.searchParams.get("amount")
  // The proxy already rejected unauthenticated calls; re-read the session here
  // so the response names the acting user (away-drill evidence: an actAs-minted
  // session identifies the granting user to Maple's own API).
  const actor = await resolveMapleSession(req)
  try {
    const txn = transferMoney({
      amount: amountRaw != null ? Number(amountRaw) : undefined,
      recipientName: url.searchParams.get("recipient_name") ?? undefined,
      memo: url.searchParams.get("memo") ?? undefined,
    })
    return ok({ ...txn, actor: actor ? { id: actor.subject, name: actor.display } : null })
  } catch (err) {
    // Bad amount / overdraft is a clean 400 the agent can relay; a real bug
    // still surfaces.
    if (err instanceof TransferError) return badRequest(err.message)
    throw err
  }
}
