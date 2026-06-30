/**
 * GET /api/flowlet/poll — the Flowlet-layer detector tick. The client polls this
 * (~2s). It reads Maple's existing transactions, matches active rules against any
 * new charge, and fires the Slack snitch. Returns the fire events so the client
 * can surface a "Rule fired → posted" confirmation.
 */
import { runPoll } from "@/flowlet/poller"
import { ok } from "@/server/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  const events = await runPoll()
  return ok({ events })
}
