/**
 * The as-of projection exists so rehearsed firings differ from each other
 * honestly. Two properties matter and both are asserted here: uploads DO roll
 * back (that is the whole point), and verification does NOT (Cadence has no
 * verify timestamp, so a projection that moved it would be inventing history).
 */
import { beforeEach, describe, expect, it } from "vitest"
import { documentAsOf, documentsAsOf, parseInstant } from "@/server/asof"
import { listDeadlineEntries } from "@/server/clients"
import { __reseed, getStore } from "@/server/store"
import type { DocumentRequest } from "@/server/types"

const anchor = new Date("2026-07-02T09:00:00-07:00")

beforeEach(() => {
  __reseed(anchor)
})

const doc = (id: string): DocumentRequest =>
  getStore().documents.find(d => d.id === id)!

describe("parseInstant", () => {
  it("degrades to undefined rather than throwing, so a bad bound reads live", () => {
    expect(parseInstant(null)).toBeUndefined()
    expect(parseInstant("")).toBeUndefined()
    expect(parseInstant("not-a-date")).toBeUndefined()
    expect(parseInstant("2026-07-01T00:00:00.000Z")?.toISOString())
      .toBe("2026-07-01T00:00:00.000Z")
  })
})

describe("documentAsOf", () => {
  it("rolls an upload back to missing before it landed, dropping the file", () => {
    const bank = doc("doc_rivera_bank")
    expect(bank.status).toBe("received")
    expect(bank.file).toBeDefined()

    const before = new Date(new Date(bank.file!.uploadedAt).getTime() - 1000)
    const projected = documentAsOf(bank, before)
    expect(projected.status).toBe("missing")
    expect(projected.file).toBeUndefined()
    expect(projected.note).toBeUndefined()
    // Identity fields survive — it is the same request, earlier in its life.
    expect(projected.id).toBe(bank.id)
    expect(projected.kind).toBe(bank.kind)
  })

  it("leaves the document untouched once the upload has landed", () => {
    const bank = doc("doc_rivera_bank")
    const after = new Date(new Date(bank.file!.uploadedAt).getTime() + 1000)
    expect(documentAsOf(bank, after)).toEqual(bank)
  })

  it("rolls a verified document back too, when its upload had not landed yet", () => {
    const verified = doc("doc_rivera_prior_return")
    expect(verified.status).toBe("verified")
    // Sound: it cannot have been verified before it was uploaded.
    const projected = documentAsOf(verified, new Date("2000-01-01T00:00:00.000Z"))
    expect(projected.status).toBe("missing")
    expect(projected.file).toBeUndefined()
  })

  it("STILL reads verified just after the upload — the documented limitation", () => {
    const verified = doc("doc_rivera_prior_return")
    const justAfterUpload = new Date(new Date(verified.file!.uploadedAt).getTime() + 1000)
    // A second after the file landed it was certainly not reviewed yet, but
    // Cadence never timestamps the verify transition, so the projection leaves
    // it alone rather than guessing. This asymmetry is the reason the tool
    // description tells the model never to claim a past verification date.
    expect(documentAsOf(verified, justAfterUpload).status).toBe("verified")
  })

  it("leaves a never-uploaded document alone — there is nothing to roll back", () => {
    const missing = doc("doc_rivera_w2")
    expect(missing.file).toBeUndefined()
    expect(documentAsOf(missing, new Date("2000-01-01T00:00:00.000Z"))).toEqual(missing)
  })

  it("is the identity when no instant is given", () => {
    expect(documentsAsOf()).toEqual(getStore().documents)
  })
})

describe("listDeadlineEntries(asOf)", () => {
  it("shows MORE outstanding work the further back it is projected", () => {
    const outstanding = (asOf?: Date) =>
      listDeadlineEntries(asOf).reduce((n, e) => n + e.missingDocKinds.length, 0)

    const live = outstanding()
    const rolledBack = outstanding(new Date("2000-01-01T00:00:00.000Z"))
    // Every seeded upload is projected away, so nothing can have arrived yet.
    expect(rolledBack).toBeGreaterThan(live)
    expect(rolledBack).toBe(getStore().documents.length)
  })

  it("moves a client back into missing_docs before their upload landed", () => {
    const complete = listDeadlineEntries().find(e => e.status === "complete")
    expect(complete).toBeDefined()
    const projected = listDeadlineEntries(new Date("2000-01-01T00:00:00.000Z"))
      .find(e => e.id === complete!.id)!
    expect(projected.status).toBe("missing_docs")
    expect(projected.progress.received).toBe(0)
    expect(projected.progress.total).toBe(complete!.progress.total)
  })
})
