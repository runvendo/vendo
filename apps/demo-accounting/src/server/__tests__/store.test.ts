import { describe, it, expect, beforeEach } from "vitest"
import { buildSeed } from "../seed"
import { __reseed, getStore, resetStore } from "../store"
import { clientsMissingDocs, transitionDocument } from "../documents"
import { sendMessage } from "../messages"

const anchor = new Date("2026-07-02T09:00:00-07:00")

beforeEach(() => {
  __reseed(anchor)
})

describe("store reset", () => {
  it("__reseed restores an exact fresh seed after mutations", () => {
    const doc = getStore().documents.find(d => d.status === "missing")!
    transitionDocument(doc.id, "receive", { fileName: "upload.pdf" })
    sendMessage(doc.clientId, "firm", "Maya Alvarez", "Received your upload, taking a look now.")

    const reseeded = __reseed(anchor)
    expect(reseeded).toEqual(buildSeed(anchor))
  })

  it("resetStore reseeds to the opening demo state", () => {
    const store = getStore()
    const doc = store.documents.find(d => d.status === "missing")!
    transitionDocument(doc.id, "receive")
    transitionDocument(doc.id, "verify")
    sendMessage(doc.clientId, "client", "Someone", "Here you go, let me know if anything else is needed.")

    const fresh = resetStore()
    expect(getStore()).toBe(fresh)
    expect(fresh.clients.length).toBe(12)
    expect(clientsMissingDocs()).toBe(8)
    const sameDoc = fresh.documents.find(d => d.id === doc.id)
    expect(sameDoc?.status).toBe("missing")
    expect(sameDoc?.file).toBeUndefined()
  })
})
