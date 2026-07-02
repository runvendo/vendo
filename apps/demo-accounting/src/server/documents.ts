import { recordActivity } from "./activity"
import { getStore } from "./store"
import type { DocumentRequest } from "./types"

export type DocumentAction = "receive" | "verify" | "reject"

export interface TransitionOptions {
  fileName?: string
  reason?: string
}

export class DocumentError extends Error {
  constructor(
    readonly code: "not_found" | "invalid_transition",
    message: string,
  ) {
    super(message)
    this.name = "DocumentError"
  }
}

/** Statuses from which a firm review action (verify/reject) is valid. */
const REVIEWABLE = ["received", "needs_review"] as const

function invalid(doc: DocumentRequest, action: DocumentAction): DocumentError {
  return new DocumentError(
    "invalid_transition",
    `Cannot ${action} document ${doc.id} in status '${doc.status}'`,
  )
}

/**
 * Enforce the document lifecycle documented in types.ts:
 * receive: missing -> received (attaches the uploaded file, clears any note)
 * verify:  received | needs_review -> verified
 * reject:  received | needs_review -> missing (records the reason, clears the file)
 */
export function transitionDocument(
  docId: string,
  action: DocumentAction,
  opts: TransitionOptions = {},
): DocumentRequest {
  const store = getStore()
  const doc = store.documents.find(d => d.id === docId)
  if (!doc) throw new DocumentError("not_found", `Unknown document: ${docId}`)
  const client = store.clients.find(c => c.id === doc.clientId)
  const clientName = client?.businessName ?? doc.clientId

  switch (action) {
    case "receive": {
      if (doc.status !== "missing") throw invalid(doc, action)
      doc.status = "received"
      doc.file = {
        name: opts.fileName ?? `${doc.kind.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.pdf`,
        uploadedAt: new Date().toISOString(),
      }
      delete doc.note
      recordActivity(
        "upload_received",
        `${client?.contactName ?? "Client"} uploaded ${doc.kind} (${doc.file.name})`,
        doc.clientId,
      )
      break
    }
    case "verify": {
      if (!REVIEWABLE.includes(doc.status as (typeof REVIEWABLE)[number])) {
        throw invalid(doc, action)
      }
      doc.status = "verified"
      recordActivity("document_verified", `${doc.kind} verified for ${clientName}`, doc.clientId)
      break
    }
    case "reject": {
      if (!REVIEWABLE.includes(doc.status as (typeof REVIEWABLE)[number])) {
        throw invalid(doc, action)
      }
      doc.status = "missing"
      if (opts.reason) doc.note = opts.reason
      delete doc.file
      recordActivity(
        "document_rejected",
        `${doc.kind} rejected for ${clientName}${opts.reason ? `: ${opts.reason}` : ""}`,
        doc.clientId,
      )
      break
    }
  }
  return doc
}

/** "3 of 6 received" — received counts every document that is no longer missing. */
export function clientDocProgress(clientId: string): { received: number; total: number } {
  const docs = getStore().documents.filter(d => d.clientId === clientId)
  return {
    received: docs.filter(d => d.status !== "missing" && d.status !== "rejected").length,
    total: docs.length,
  }
}

/** Number of clients with at least one outstanding (missing/rejected) document. */
export function clientsMissingDocs(): number {
  const store = getStore()
  return store.clients.filter(c =>
    store.documents.some(
      d => d.clientId === c.id && (d.status === "missing" || d.status === "rejected"),
    ),
  ).length
}

export interface DashboardMetrics {
  clientsMissingDocs: number
  documentsOutstanding: number
  documentsReceived: number
  documentsTotal: number
  nearestDeadline: string | null
}

export function dashboardMetrics(): DashboardMetrics {
  const store = getStore()
  const total = store.documents.length
  const outstanding = store.documents.filter(
    d => d.status === "missing" || d.status === "rejected",
  ).length
  const nearestDeadline =
    [...store.clients]
      .map(c => c.filingDeadline)
      .sort((a, b) => +new Date(a) - +new Date(b))[0] ?? null
  return {
    clientsMissingDocs: clientsMissingDocs(),
    documentsOutstanding: outstanding,
    documentsReceived: total - outstanding,
    documentsTotal: total,
    nearestDeadline,
  }
}
