// EXAMPLE MUTATION — the "real action with consent" beat acts through this.
// `vendo sync .` never grades from names: a plain POST carries no protocol
// fact, so this tool stays ungraded (which ASKS) until the AI judge grades it
// `write` in judgments.json. policy.json asks on both write and destructive,
// so the agent only reaches it after the visitor approves the consent card.
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
