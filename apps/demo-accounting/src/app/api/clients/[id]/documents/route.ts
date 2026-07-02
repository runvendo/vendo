import { notFound, ok } from "@/server/http"
import { getStore } from "@/server/store"

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const store = getStore()
  if (!store.clients.some(c => c.id === id)) return notFound(`Unknown client: ${id}`)
  return ok(store.documents.filter(d => d.clientId === id))
}
