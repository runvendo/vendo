/**
 * /api/flowlet/integrations — REAL Composio connect flow + the demo store gate.
 *
 *  - GET (no query) returns the catalog with live `connected` flags.
 *  - GET ?status&id=<toolkit>&account=<connectedAccountId> polls Composio for the
 *    connection's status. When ACTIVE it ALSO marks the toolkit connected in the
 *    demo store (the agent's ingestion gate), so the agent gains it next turn.
 *  - POST { id, action: "authorize" } begins/resumes the toolkit's OAuth and
 *    returns { redirectUrl, connectedAccountId } for the client popup + poll.
 *  - POST { id, action: "disconnect" } flips the demo store off (store only —
 *    it does NOT delete the real Composio account).
 *
 * The store is the single source of truth for what the agent ingests, but a
 * toolkit only becomes "connected" once Composio reports it ACTIVE.
 */
import {
  listIntegrations,
  disconnect,
  connect,
} from "@/flowlet/connections-store"
import {
  authorizeToolkit,
  toolkitConnectionStatus,
  isToolkitConnected,
} from "@/flowlet/composio-server"
import { ok, badRequest } from "@/server/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const url = new URL(req.url)
  if (url.searchParams.has("status")) {
    const id = url.searchParams.get("id") ?? ""
    const account = url.searchParams.get("account") ?? ""
    if (!id || !account) return badRequest("status requires id and account")
    try {
      const status = await toolkitConnectionStatus(account)
      // The store is the agent gate: only mark connected once Composio is ACTIVE.
      if (status === "active") connect(id)
      return ok({ status })
    } catch {
      return ok({ status: "failed" as const })
    }
  }
  return ok({ integrations: listIntegrations() })
}

export async function POST(req: Request) {
  let body: { id?: unknown; action?: unknown }
  try {
    body = (await req.json()) as { id?: unknown; action?: unknown }
  } catch {
    return badRequest("invalid JSON body")
  }

  const id = typeof body.id === "string" ? body.id : ""
  const action = body.action
  if (!id) return badRequest("missing integration id")

  if (action === "connect") {
    try {
      // Fast path: already authorized in Composio -> mark connected immediately.
      if (await isToolkitConnected(id)) {
        connect(id)
        return ok({ connected: true })
      }
      // Otherwise begin the real OAuth and hand the client the URL to open.
      const { redirectUrl, connectedAccountId } = await authorizeToolkit(id)
      return ok({ connected: false, redirectUrl, connectedAccountId })
    } catch (err) {
      return badRequest(
        `connect failed: ${err instanceof Error ? err.message : "unknown error"}`,
      )
    }
  }

  if (action === "authorize") {
    try {
      const { redirectUrl, connectedAccountId } = await authorizeToolkit(id)
      return ok({ redirectUrl, connectedAccountId })
    } catch (err) {
      return badRequest(
        `authorize failed: ${err instanceof Error ? err.message : "unknown error"}`,
      )
    }
  }

  if (action === "disconnect") {
    disconnect(id)
    return ok({ integrations: listIntegrations() })
  }

  return badRequest("action must be 'authorize' or 'disconnect'")
}
