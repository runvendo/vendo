/**
 * GET /api/flowlet/integrations — live Composio connection status for the demo
 * user, so the dock's Integrations rail shows real "Connected" state for Gmail
 * and Slack rather than a hardcoded seed.
 */
import { ok } from "@/server/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const USER_ID = "flowlet-demo"
const API = "https://backend.composio.dev/api/v3"

export async function GET() {
  const apiKey = process.env.COMPOSIO_API_KEY
  const base = [
    { id: "gmail", name: "Gmail", connected: false },
    { id: "slack", name: "Slack", connected: false },
  ]
  if (!apiKey) return ok({ integrations: base })

  try {
    const res = await fetch(`${API}/connected_accounts?user_ids=${USER_ID}`, {
      headers: { "x-api-key": apiKey },
    })
    const json = (await res.json()) as { items?: { toolkit?: { slug?: string }; status?: string }[] }
    const items = json.items ?? []
    const active = (slug: string) =>
      items.some((c) => (c.toolkit?.slug ?? "").toLowerCase() === slug && c.status === "ACTIVE")
    return ok({
      integrations: [
        { id: "gmail", name: "Gmail", connected: active("gmail") },
        { id: "slack", name: "Slack", connected: active("slack") },
      ],
    })
  } catch {
    return ok({ integrations: base })
  }
}
