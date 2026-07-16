// EXAMPLE MUTATION — the "real action with consent" beat acts through this.
// Declared in openapi.json as write-risk, so the agent only reaches it after
// the visitor approves the consent card.
import { archiveItem, ItemError } from "@/server/items"
import { ok, notFound } from "@/server/http"

export const dynamic = "force-dynamic"

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    return ok(archiveItem(id))
  } catch (err) {
    // Unknown id is a clean 404 the agent can relay; a real bug still surfaces.
    if (err instanceof ItemError) return notFound(err.message)
    throw err
  }
}
