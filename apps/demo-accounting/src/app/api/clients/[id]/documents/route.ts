import { documentsAsOf, parseInstant } from "@/server/asof"
import { notFound, ok } from "@/server/http"
import { getStore } from "@/server/store"

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const store = getStore()
  if (!store.clients.some(c => c.id === id)) return notFound(`Unknown client: ${id}`)
  // A snapshot read: `to` is the as-of instant, `from` is accepted but unused
  // (a checklist has no window). Both are declared so automation rehearsal
  // pins the firing's time onto `to`.
  const to = parseInstant(new URL(req.url).searchParams.get("to"))
  return ok(documentsAsOf(to).filter(d => d.clientId === id))
}
