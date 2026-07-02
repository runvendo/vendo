// Cadence domain types.
//
// Document lifecycle (enforced by transitionDocument in documents.ts):
//
//   missing --receive(file)--> received                client uploaded, awaiting firm review
//   received | needs_review --verify--> verified       firm confirmed the document is correct
//   received | needs_review --reject(reason)--> missing wrong document; note recorded, file cleared
//
// 'needs_review' is a flagged variant of 'received': an upload that looks off and
// needs closer inspection (seeded for texture now; later set by the demo's
// simulated wrong-document uploads). It accepts the same verify/reject
// transitions as 'received'. 'rejected' is reserved in the union for later API
// beats that surface a just-rejected upload; the reject transition itself
// returns the document to 'missing' so it can be re-requested.

export type EntityType = "s_corp" | "sole_prop" | "partnership" | "c_corp" | "individual"

export type DocumentStatus = "missing" | "received" | "needs_review" | "verified" | "rejected"

export interface DocumentFile {
  name: string
  uploadedAt: string // ISO 8601
}

export interface DocumentRequest {
  id: string
  clientId: string
  kind: string // e.g. "W-2", "1099-NEC", "Bank statements (2025)", "Prior-year return"
  status: DocumentStatus
  note?: string // rejection reason, shown until the client re-uploads
  file?: DocumentFile
}

export interface Client {
  id: string
  businessName: string
  entityType: EntityType
  contactName: string
  contactEmail: string
  assigneeId: string
  filingDeadline: string // ISO 8601
}

export type MessageDirection = "firm" | "client"

export interface Message {
  id: string
  clientId: string
  direction: MessageDirection
  author: string
  body: string
  sentAt: string // ISO 8601
}

export type ActivityType =
  | "upload_received"
  | "document_verified"
  | "document_rejected"
  | "message_sent"
  | "deadline_approaching"

export interface ActivityEvent {
  id: string
  type: ActivityType
  clientId?: string
  summary: string
  at: string // ISO 8601
}

export interface Staff {
  id: string
  name: string
  role: string
  initials: string
}
