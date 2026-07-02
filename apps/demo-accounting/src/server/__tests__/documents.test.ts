import { describe, it, expect, beforeEach } from "vitest"
import { __reseed, getStore } from "../store"
import { DomainError } from "../errors"
import {
  clientDocProgress,
  clientsMissingDocs,
  dashboardMetrics,
  transitionDocument,
} from "../documents"

const anchor = new Date("2026-07-02T09:00:00-07:00")

beforeEach(() => {
  __reseed(anchor)
})

function firstMissingDoc() {
  const doc = getStore().documents.find(d => d.status === "missing")
  if (!doc) throw new Error("seed has no missing document")
  return doc
}

describe("transitionDocument", () => {
  it("walks the happy path missing -> received -> verified", () => {
    const doc = firstMissingDoc()

    const received = transitionDocument(doc.id, "receive", { fileName: "w2-2025.pdf" })
    expect(received.status).toBe("received")
    expect(received.file?.name).toBe("w2-2025.pdf")
    expect(Number.isNaN(Date.parse(received.file!.uploadedAt))).toBe(false)

    const verified = transitionDocument(doc.id, "verify")
    expect(verified.status).toBe("verified")
    expect(verified.file?.name).toBe("w2-2025.pdf")
  })

  it("verifies a document seeded as needs_review", () => {
    const doc = getStore().documents.find(d => d.status === "needs_review")
    expect(doc).toBeTruthy()
    expect(transitionDocument(doc!.id, "verify").status).toBe("verified")
  })

  it("reject returns the document to missing, records the note, clears the file", () => {
    const doc = firstMissingDoc()
    transitionDocument(doc.id, "receive", { fileName: "statement.pdf" })

    const rejected = transitionDocument(doc.id, "reject", {
      reason: "Personal account statement uploaded instead of the business account",
    })
    expect(rejected.status).toBe("missing")
    expect(rejected.note).toBe(
      "Personal account statement uploaded instead of the business account",
    )
    expect(rejected.file).toBeUndefined()
  })

  it("receive clears a stale rejection note", () => {
    const doc = firstMissingDoc()
    transitionDocument(doc.id, "receive")
    transitionDocument(doc.id, "reject", { reason: "Wrong year" })
    const re = transitionDocument(doc.id, "receive", { fileName: "correct.pdf" })
    expect(re.note).toBeUndefined()
    expect(re.status).toBe("received")
  })

  it("throws a typed error on invalid transitions", () => {
    const doc = firstMissingDoc()

    expect(() => transitionDocument(doc.id, "verify")).toThrowError(DomainError)
    expect(() => transitionDocument(doc.id, "reject")).toThrowError(DomainError)

    transitionDocument(doc.id, "receive")
    expect(() => transitionDocument(doc.id, "receive")).toThrowError(DomainError)

    transitionDocument(doc.id, "verify")
    expect(() => transitionDocument(doc.id, "verify")).toThrowError(DomainError)
    expect(() => transitionDocument(doc.id, "reject")).toThrowError(DomainError)

    try {
      transitionDocument(doc.id, "receive")
      expect.unreachable("receive on a verified doc must throw")
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError)
      expect((err as DomainError).code).toBe("invalid_transition")
    }
  })

  it("throws a typed not_found error for unknown documents", () => {
    try {
      transitionDocument("doc_nope", "receive")
      expect.unreachable("unknown doc must throw")
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError)
      expect((err as DomainError).code).toBe("not_found")
    }
  })

  it("records activity for transitions", () => {
    const before = getStore().activity.length
    const doc = firstMissingDoc()
    transitionDocument(doc.id, "receive")
    transitionDocument(doc.id, "verify")
    const activity = getStore().activity
    expect(activity.length).toBe(before + 2)
    expect(activity[0].type).toBe("document_verified")
    expect(activity[1].type).toBe("upload_received")
    expect(activity[0].clientId).toBe(doc.clientId)
  })
})

describe("derived helpers", () => {
  it("clientDocProgress reports Rivera Landscaping at 3 of 6 received", () => {
    const store = getStore()
    const rivera = store.clients.find(c => c.businessName === "Rivera Landscaping LLC")!
    expect(clientDocProgress(rivera.id)).toEqual({ received: 3, total: 6 })
  })

  it("clientsMissingDocs counts 8 on a fresh seed", () => {
    expect(clientsMissingDocs()).toBe(8)
  })

  it("dashboardMetrics reflects the seed", () => {
    const store = getStore()
    const metrics = dashboardMetrics()
    const outstanding = store.documents.filter(
      d => d.status === "missing" || d.status === "rejected",
    ).length

    expect(metrics.clientsMissingDocs).toBe(8)
    expect(metrics.documentsTotal).toBe(store.documents.length)
    expect(metrics.documentsOutstanding).toBe(outstanding)
    expect(metrics.documentsReceived).toBe(store.documents.length - outstanding)
    const soonest = [...store.clients]
      .map(c => c.filingDeadline)
      .sort((a, b) => +new Date(a) - +new Date(b))[0]
    expect(metrics.nearestDeadline).toBe(soonest)
  })

  it("clientsMissingDocs drops by 1 after clearing one client's missing docs", () => {
    const store = getStore()
    const rivera = store.clients.find(c => c.businessName === "Rivera Landscaping LLC")!
    const missing = store.documents.filter(
      d => d.clientId === rivera.id && d.status === "missing",
    )
    expect(missing.length).toBeGreaterThan(0)

    for (const doc of missing) {
      transitionDocument(doc.id, "receive")
      transitionDocument(doc.id, "verify")
    }

    expect(clientsMissingDocs()).toBe(7)
    expect(dashboardMetrics().clientsMissingDocs).toBe(7)
    const progress = clientDocProgress(rivera.id)
    expect(progress.received).toBe(progress.total)
  })
})
