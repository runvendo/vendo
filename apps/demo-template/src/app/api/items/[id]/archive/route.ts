// EXAMPLE MUTATION — the "real action with consent" beat acts through this.
// `vendo sync .` derives this tool's risk from the method + operationId
// ("archive" is a destructive word → destructive), so the agent only reaches
// it after the visitor approves the consent card. policy.json asks on both
// write and destructive, so a renamed mutation stays consent-gated.
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
