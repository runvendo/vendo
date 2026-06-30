/**
 * /api/flowlet/integrations — the demo connection store is the source of truth.
 *
 *  - GET  returns the catalog with live `connected` flags.
 *  - POST { id, action: "connect" | "disconnect" } mutates the store (which also
 *    drives which toolkits the chat agent ingests) and returns the updated list.
 *
 * No live Composio `active()` check anymore: in the demo, "connecting" flips the
 * store flag on screen rather than running a real OAuth round-trip.
 */
import {
  listIntegrations,
  connect,
  disconnect,
} from "@/flowlet/connections-store"
import { ok, badRequest } from "@/server/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
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
  if (action !== "connect" && action !== "disconnect") {
    return badRequest("action must be 'connect' or 'disconnect'")
  }

  if (action === "connect") connect(id)
  else disconnect(id)

  return ok({ integrations: listIntegrations() })
}
