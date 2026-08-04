import { recordActivity } from "./activity"
import { DomainError } from "./errors"
import { getStore } from "./store"
import type { DocumentRequest } from "./types"

export type DocumentAction = "receive" | "verify" | "reject"

export interface TransitionOptions {
  fileName?: string
  reason?: string
}

/** Statuses from which a firm review action (verify/reject) is valid. */
const REVIEWABLE = ["received", "needs_review"] as const

/** Lowercase hyphen-separated slug, used for generated upload file names. */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
}

function invalid(doc: DocumentRequest, action: string): DomainError {
  return new DomainError(
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
  if (!doc) throw new DomainError("not_found", `Unknown document: ${docId}`)
  const client = store.clients.find(c => c.id === doc.clientId)
  const clientName = client?.businessName ?? doc.clientId

  switch (action) {
    case "receive": {
      if (doc.status !== "missing") throw invalid(doc, action)
      doc.status = "received"
      doc.file = {
        name: opts.fileName ?? `${slugify(doc.kind)}.pdf`,
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

/**
 * Demo choreography: a client "uploads" a file that looks wrong (e.g. a
 * personal statement instead of the business one). missing -> needs_review
 * with the file attached and an explanatory note, making needs_review
 * reachable at runtime rather than only via seed data. Verify/reject apply
 * from there exactly as for 'received'.
 */
export function receiveForReview(
  docId: string,
  opts: { fileName?: string; note: string },
): DocumentRequest {
  const store = getStore()
  const doc = store.documents.find(d => d.id === docId)
  if (!doc) throw new DomainError("not_found", `Unknown document: ${docId}`)
  if (doc.status !== "missing") throw invalid(doc, "receive")
  const client = store.clients.find(c => c.id === doc.clientId)

  doc.status = "needs_review"
  doc.note = opts.note
  doc.file = {
    name: opts.fileName ?? `${slugify(doc.kind)}.pdf`,
    uploadedAt: new Date().toISOString(),
  }
  recordActivity(
    "upload_received",
    `${client?.contactName ?? "Client"} uploaded ${doc.kind} (${doc.file.name}) — flagged for review`,
    doc.clientId,
  )
  return doc
}

/** "3 of 6 received" — received counts every document that is no longer missing or rejected. */
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
  clientsTotal: number
  nearestDeadline: string | null
  nearestDeadlineClient: { id: string; businessName: string; filingDeadline: string } | null
}

/**
 * The full shape of GET /api/dashboard and POST /api/demo/reset (the
 * DashboardMetrics schema in openapi.json). Both routes must return exactly
 * this, so keep any additions here rather than shaping inline in a route.
 */
export function dashboardMetrics(): DashboardMetrics {
  const store = getStore()
  const total = store.documents.length
  const outstanding = store.documents.filter(
    d => d.status === "missing" || d.status === "rejected",
  ).length
  const nearest =
    [...store.clients].sort(
      (a, b) => +new Date(a.filingDeadline) - +new Date(b.filingDeadline),
    )[0] ?? null
  return {
    clientsMissingDocs: clientsMissingDocs(),
    documentsOutstanding: outstanding,
    documentsReceived: total - outstanding,
    documentsTotal: total,
    clientsTotal: store.clients.length,
    nearestDeadline: nearest?.filingDeadline ?? null,
    nearestDeadlineClient: nearest
      ? {
          id: nearest.id,
          businessName: nearest.businessName,
          filingDeadline: nearest.filingDeadline,
        }
      : null,
  }
}
