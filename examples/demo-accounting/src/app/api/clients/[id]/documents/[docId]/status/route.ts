import { transitionDocument, type DocumentAction } from "@/server/documents"
import { badRequest, fromDomainError, notFound, ok } from "@/server/http"
import { getStore } from "@/server/store"

const ACTIONS: readonly DocumentAction[] = ["receive", "verify", "reject"]

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; docId: string }> },
) {
  const { id, docId } = await params
  const store = getStore()
  if (!store.clients.some(c => c.id === id)) return notFound(`Unknown client: ${id}`)
  const doc = store.documents.find(d => d.id === docId)
  if (!doc || doc.clientId !== id) {
    return notFound(`Client ${id} has no document ${docId}`)
  }

  const body = (await req.json().catch(() => ({}))) as {
    action?: string
    fileName?: string
    reason?: string
  }
  if (!ACTIONS.includes(body.action as DocumentAction)) {
    return badRequest("action must be one of: receive, verify, reject")
  }

  try {
    return ok(
      transitionDocument(docId, body.action as DocumentAction, {
        fileName: body.fileName,
        reason: body.reason,
      }),
    )
  } catch (err) {
    return fromDomainError(err)
  }
}
