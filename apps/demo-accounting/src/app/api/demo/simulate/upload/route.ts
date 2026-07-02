// POST /api/demo/simulate/upload — demo choreography: a named client "uploads"
// a file. variant 'correct' lands the document in 'received'; variant 'wrong'
// (e.g. a personal bank statement instead of the business one) lands it in
// 'needs_review' with an explanatory note. Either way a client -> firm message
// and activity are recorded so the UI shows the client uploading.
import { receiveForReview, transitionDocument } from "@/server/documents"
import { badRequest, fromDomainError, notFound, ok } from "@/server/http"
import { sendMessage } from "@/server/messages"
import { getStore } from "@/server/store"

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    clientId?: string
    docId?: string
    variant?: string
    fileName?: string
  }
  const { clientId, docId, variant, fileName } = body
  if (!clientId || !docId) return badRequest("clientId and docId are required")
  if (variant !== "correct" && variant !== "wrong") {
    return badRequest("variant must be 'correct' or 'wrong'")
  }

  const store = getStore()
  const client = store.clients.find(c => c.id === clientId)
  if (!client) return notFound(`Unknown client: ${clientId}`)
  const doc = store.documents.find(d => d.id === docId)
  if (!doc || doc.clientId !== clientId) {
    return notFound(`Client ${clientId} has no document ${docId}`)
  }

  try {
    const document =
      variant === "correct"
        ? transitionDocument(docId, "receive", {
            fileName: fileName ?? `${slug(client.businessName)}-${slug(doc.kind)}.pdf`,
          })
        : receiveForReview(docId, {
            fileName: fileName ?? "personal-checking-statements-jan-jun.pdf",
            note: `Uploaded file appears to be a personal bank statement; requested ${doc.kind}.`,
          })
    const message = sendMessage(
      clientId,
      "client",
      client.contactName,
      `Just uploaded ${document.file?.name} for the ${doc.kind} request through the portal.`,
    )
    return ok({ document, message })
  } catch (err) {
    return fromDomainError(err)
  }
}
