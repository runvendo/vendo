import { badRequest, fromDomainError, notFound, ok } from "@/server/http"
import { sendMessage } from "@/server/messages"
import { getStore } from "@/server/store"

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const store = getStore()
  if (!store.clients.some(c => c.id === id)) return notFound(`Unknown client: ${id}`)
  const thread = store.messages
    .filter(m => m.clientId === id)
    .sort((a, b) => +new Date(a.sentAt) - +new Date(b.sentAt))
  return ok(thread)
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = (await req.json().catch(() => ({}))) as { body?: string; author?: string }
  const text = typeof body.body === "string" ? body.body.trim() : ""
  if (!text) return badRequest("body is required")

  try {
    return ok(sendMessage(id, "firm", body.author?.trim() || "Maya Alvarez", text))
  } catch (err) {
    return fromDomainError(err)
  }
}
