import { documentsAsOf } from "./asof"
import { clientDocProgress } from "./documents"
import { getStore } from "./store"
import type { Client, Staff } from "./types"

/**
 * Derived from the client's documents, never stored:
 * missing_docs — at least one document is still outstanding (missing/rejected)
 * in_review    — everything is uploaded but some uploads await firm review
 * complete     — every document is verified
 */
export type ClientStatus = "missing_docs" | "in_review" | "complete"

export interface ClientSummary extends Client {
  progress: { received: number; total: number }
  status: ClientStatus
  assignee: Staff | null
}

export function clientStatus(clientId: string, asOf?: Date): ClientStatus {
  const docs = documentsAsOf(asOf).filter(d => d.clientId === clientId)
  if (docs.some(d => d.status === "missing" || d.status === "rejected")) return "missing_docs"
  if (docs.some(d => d.status === "received" || d.status === "needs_review")) return "in_review"
  return "complete"
}

export function clientSummary(client: Client, asOf?: Date): ClientSummary {
  return {
    ...client,
    progress: clientDocProgress(client.id, asOf),
    status: clientStatus(client.id, asOf),
    assignee: getStore().staff.find(s => s.id === client.assigneeId) ?? null,
  }
}

export interface ClientQuery {
  filter?: string | null // "missing_docs" narrows to clients with outstanding documents
  q?: string | null // case-insensitive match on business or contact name
}

export function listClientSummaries(query: ClientQuery = {}, asOf?: Date): ClientSummary[] {
  const q = query.q?.trim().toLowerCase()
  return getStore()
    // Not point-free: clientSummary's second parameter is `asOf`, and map
    // would hand it the array index.
    .clients.map(c => clientSummary(c, asOf))
    .filter(c => query.filter !== "missing_docs" || c.status === "missing_docs")
    .filter(
      c =>
        !q ||
        c.businessName.toLowerCase().includes(q) ||
        c.contactName.toLowerCase().includes(q),
    )
}

export function getClientSummary(id: string): ClientSummary | null {
  const client = getStore().clients.find(c => c.id === id)
  return client ? clientSummary(client) : null
}

export interface DeadlineEntry extends ClientSummary {
  missingDocKinds: string[]
}

/** All clients ordered by filing deadline (soonest first), with what is still
 *  owed. `asOf` projects each checklist back (see ./asof), so a rehearsed
 *  firing sees the documents that were genuinely outstanding at its own
 *  scheduled time rather than today's. */
export function listDeadlineEntries(asOf?: Date): DeadlineEntry[] {
  const store = getStore()
  const documents = documentsAsOf(asOf)
  return [...store.clients]
    .sort((a, b) => +new Date(a.filingDeadline) - +new Date(b.filingDeadline))
    .map(c => ({
      ...clientSummary(c, asOf),
      missingDocKinds: documents
        .filter(d => d.clientId === c.id && (d.status === "missing" || d.status === "rejected"))
        .map(d => d.kind),
    }))
}
