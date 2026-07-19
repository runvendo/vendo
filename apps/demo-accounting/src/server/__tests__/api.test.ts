import { describe, it, expect, beforeEach } from "vitest"
import { __reseed, getStore } from "../store"
import { transitionDocument } from "../documents"
import { GET as getDashboard } from "@/app/api/dashboard/route"
import { GET as listClients } from "@/app/api/clients/route"
import { GET as getClient } from "@/app/api/clients/[id]/route"
import { GET as listClientDocuments } from "@/app/api/clients/[id]/documents/route"
import { POST as postDocumentStatus } from "@/app/api/clients/[id]/documents/[docId]/status/route"
import {
  GET as listClientMessages,
  POST as postClientMessage,
} from "@/app/api/clients/[id]/messages/route"
import { GET as listDeadlines } from "@/app/api/deadlines/route"
import { GET as listActivity } from "@/app/api/activity/route"
import { POST as postDemoReset } from "@/app/api/demo/reset/route"
import { POST as postSimulateUpload } from "@/app/api/demo/simulate/upload/route"

const anchor = new Date("2026-07-02T09:00:00-07:00")

beforeEach(() => {
  __reseed(anchor)
})

function withParams<T extends Record<string, string>>(p: T) {
  return { params: Promise.resolve(p) }
}

function post(url: string, body?: unknown) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

describe("GET /api/dashboard", () => {
  it("returns the metrics the dashboard renders", async () => {
    const res = await getDashboard()
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.clientsMissingDocs).toBe(8)
    expect(data.clientsTotal).toBe(12)
    expect(data.documentsTotal).toBeGreaterThan(0)
    expect(data.documentsReceived + data.documentsOutstanding).toBe(data.documentsTotal)
    expect(Number.isNaN(Date.parse(data.nearestDeadline))).toBe(false)
    expect(data.nearestDeadlineClient.businessName).toBe("Blue Bottle Coffee")
    expect(data.nearestDeadlineClient.filingDeadline).toBe(data.nearestDeadline)
  })
})

describe("GET /api/clients", () => {
  it("lists every client with progress, derived status and assignee", async () => {
    const res = await listClients(new Request("http://x/api/clients"))
    const { data } = await res.json()
    expect(data.length).toBe(12)

    const rivera = data.find(
      (c: { businessName: string }) => c.businessName === "Blue Bottle Coffee",
    )
    expect(rivera.progress).toEqual({ received: 3, total: 6 })
    expect(rivera.status).toBe("missing_docs")
    expect(rivera.assignee).toMatchObject({ id: "st_maya", name: "Maya Alvarez" })

    const lakeside = data.find(
      (c: { businessName: string }) => c.businessName === "Banfield Pet Hospital",
    )
    expect(lakeside.status).toBe("complete")
  })

  it("filter=missing_docs narrows to the 8 clients missing documents", async () => {
    const res = await listClients(new Request("http://x/api/clients?filter=missing_docs"))
    const { data } = await res.json()
    expect(data.length).toBe(8)
    for (const c of data) expect(c.status).toBe("missing_docs")
  })

  it("q= searches business and contact names case-insensitively", async () => {
    const res = await listClients(new Request("http://x/api/clients?q=rivera"))
    const { data } = await res.json()
    expect(data.length).toBe(1)
    expect(data[0].businessName).toBe("Blue Bottle Coffee")

    const byContact = await listClients(new Request("http://x/api/clients?q=wei+chen"))
    const contactBody = await byContact.json()
    expect(contactBody.data.length).toBe(1)
    expect(contactBody.data[0].businessName).toBe("Linear")
  })
})

describe("GET /api/clients/:id", () => {
  it("returns one client with progress and assignee", async () => {
    const res = await getClient(new Request("http://x"), withParams({ id: "cl_rivera" }))
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.businessName).toBe("Blue Bottle Coffee")
    expect(data.progress).toEqual({ received: 3, total: 6 })
    expect(data.assignee.initials).toBe("MA")
  })

  it("404s for an unknown client", async () => {
    const res = await getClient(new Request("http://x"), withParams({ id: "cl_nope" }))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe("not_found")
  })
})

describe("GET /api/clients/:id/documents", () => {
  it("lists the client's document requests", async () => {
    const res = await listClientDocuments(new Request("http://x"), withParams({ id: "cl_rivera" }))
    const { data } = await res.json()
    expect(data.length).toBe(6)
    for (const d of data) expect(d.clientId).toBe("cl_rivera")
  })

  it("404s for an unknown client", async () => {
    const res = await listClientDocuments(new Request("http://x"), withParams({ id: "cl_nope" }))
    expect(res.status).toBe(404)
  })
})

describe("POST /api/clients/:id/documents/:docId/status", () => {
  it("walks receive then verify on a missing document", async () => {
    const received = await postDocumentStatus(
      post("http://x", { action: "receive", fileName: "rivera-w2-2025.pdf" }),
      withParams({ id: "cl_rivera", docId: "doc_rivera_w2" }),
    )
    expect(received.status).toBe(200)
    const receivedBody = await received.json()
    expect(receivedBody.data.status).toBe("received")
    expect(receivedBody.data.file.name).toBe("rivera-w2-2025.pdf")

    const verified = await postDocumentStatus(
      post("http://x", { action: "verify" }),
      withParams({ id: "cl_rivera", docId: "doc_rivera_w2" }),
    )
    const verifiedBody = await verified.json()
    expect(verifiedBody.data.status).toBe("verified")
  })

  it("records the reason when rejecting", async () => {
    const res = await postDocumentStatus(
      post("http://x", { action: "reject", reason: "Statement is for the wrong year" }),
      withParams({ id: "cl_rivera", docId: "doc_rivera_bank" }),
    )
    const { data } = await res.json()
    expect(data.status).toBe("missing")
    expect(data.note).toBe("Statement is for the wrong year")
  })

  it("400s on an invalid transition with the domain message", async () => {
    const res = await postDocumentStatus(
      post("http://x", { action: "verify" }),
      withParams({ id: "cl_rivera", docId: "doc_rivera_w2" }),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe("bad_request")
    expect(body.error.message).toMatch(/Cannot verify/)
  })

  it("400s on an unknown action", async () => {
    const res = await postDocumentStatus(
      post("http://x", { action: "shred" }),
      withParams({ id: "cl_rivera", docId: "doc_rivera_w2" }),
    )
    expect(res.status).toBe(400)
  })

  it("404s when the document does not belong to the client", async () => {
    const res = await postDocumentStatus(
      post("http://x", { action: "receive" }),
      withParams({ id: "cl_rivera", docId: "doc_chen_bank" }),
    )
    expect(res.status).toBe(404)
  })

  it("404s for an unknown client", async () => {
    const res = await postDocumentStatus(
      post("http://x", { action: "receive" }),
      withParams({ id: "cl_nope", docId: "doc_rivera_w2" }),
    )
    expect(res.status).toBe(404)
  })
})

describe("GET/POST /api/clients/:id/messages", () => {
  it("lists the thread oldest-first", async () => {
    const res = await listClientMessages(new Request("http://x"), withParams({ id: "cl_rivera" }))
    const { data } = await res.json()
    expect(data.length).toBe(4)
    const times = data.map((m: { sentAt: string }) => +new Date(m.sentAt))
    expect(times).toEqual([...times].sort((a, b) => a - b))
  })

  it("posts a firm message with a default author", async () => {
    const res = await postClientMessage(
      post("http://x", { body: "Reminder: your June bank statements are still outstanding." }),
      withParams({ id: "cl_rivera" }),
    )
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.direction).toBe("firm")
    expect(data.author).toBe("Maya Alvarez")
    expect(getStore().messages.at(-1)?.id).toBe(data.id)
  })

  it("400s on an empty body", async () => {
    const res = await postClientMessage(
      post("http://x", { body: "   " }),
      withParams({ id: "cl_rivera" }),
    )
    expect(res.status).toBe(400)
  })

  it("404s for an unknown client", async () => {
    const res = await postClientMessage(
      post("http://x", { body: "Hello" }),
      withParams({ id: "cl_nope" }),
    )
    expect(res.status).toBe(404)
  })
})

describe("GET /api/deadlines", () => {
  it("sorts clients by filing deadline ascending with missing doc kinds", async () => {
    const res = await listDeadlines()
    const { data } = await res.json()
    expect(data.length).toBe(12)
    const deadlines = data.map((d: { filingDeadline: string }) => +new Date(d.filingDeadline))
    expect(deadlines).toEqual([...deadlines].sort((a, b) => a - b))

    const rivera = data[0]
    expect(rivera.businessName).toBe("Blue Bottle Coffee")
    expect(rivera.progress).toEqual({ received: 3, total: 6 })
    expect(rivera.missingDocKinds).toEqual(["W-2", "1099-NEC", "Receipts"])

    const complete = data.find(
      (d: { businessName: string }) => d.businessName === "Banfield Pet Hospital",
    )
    expect(complete.missingDocKinds).toEqual([])
  })
})

describe("GET /api/activity", () => {
  it("honors ?limit=", async () => {
    const res = await listActivity(new Request("http://x/api/activity?limit=3"))
    const { data } = await res.json()
    expect(data.length).toBe(3)
    expect(data[0].type).toBeTruthy()
  })

  it("returns the newest-first feed without a limit", async () => {
    const res = await listActivity(new Request("http://x/api/activity"))
    const { data } = await res.json()
    expect(data.length).toBe(getStore().activity.length)
    const times = data.map((e: { at: string }) => +new Date(e.at))
    expect(times).toEqual([...times].sort((a, b) => b - a))
  })
})

describe("POST /api/demo/reset", () => {
  it("restores the 8-clients-missing opening state after mutations", async () => {
    for (const doc of getStore().documents.filter(
      d => d.clientId === "cl_rivera" && d.status === "missing",
    )) {
      transitionDocument(doc.id, "receive")
      transitionDocument(doc.id, "verify")
    }
    const before = await (await getDashboard()).json()
    expect(before.data.clientsMissingDocs).toBe(7)

    const res = await postDemoReset()
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.clientsMissingDocs).toBe(8)
    expect(getStore().documents.find(d => d.id === "doc_rivera_w2")?.status).toBe("missing")
  })

  it("returns the full documented DashboardMetrics shape (the ENG-202 contract)", async () => {
    const res = await postDemoReset()
    const { data } = await res.json()

    expect(data.clientsTotal).toBe(12)
    expect(data.documentsReceived + data.documentsOutstanding).toBe(data.documentsTotal)
    expect(Number.isNaN(Date.parse(data.nearestDeadline))).toBe(false)
    expect(data.nearestDeadlineClient).toMatchObject({
      id: "cl_rivera",
      businessName: "Blue Bottle Coffee",
      filingDeadline: data.nearestDeadline,
    })

    // Reset and dashboard share one schema in openapi.json; catch any drift.
    const dashboard = await (await getDashboard()).json()
    expect(data).toEqual(dashboard.data)
  })
})

describe("POST /api/demo/simulate/upload", () => {
  it("variant=correct receives the document and records the client activity", async () => {
    const res = await postSimulateUpload(
      post("http://x", { clientId: "cl_rivera", docId: "doc_rivera_w2", variant: "correct" }),
    )
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.document.status).toBe("received")
    expect(data.document.file.name).toMatch(/\.pdf$/)
    expect(data.message.direction).toBe("client")
    expect(data.message.author).toBe("Marisol Rivera")

    const types = getStore()
      .activity.slice(0, 2)
      .map(e => e.type)
    expect(types).toContain("upload_received")
    expect(types).toContain("message_sent")
  })

  it("variant=wrong lands the document in needs_review with an explanatory note", async () => {
    const res = await postSimulateUpload(
      post("http://x", {
        clientId: "cl_chen",
        docId: "doc_chen_bank",
        variant: "wrong",
        fileName: "chase-personal-checking-jan-jun.pdf",
      }),
    )
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.document.status).toBe("needs_review")
    expect(data.document.file.name).toBe("chase-personal-checking-jan-jun.pdf")
    expect(data.document.note).toMatch(/personal/i)
    expect(data.document.note).toMatch(/Bank statements \(2025\)/)

    const upload = getStore().activity.find(e => e.type === "upload_received")
    expect(upload?.clientId).toBe("cl_chen")
  })

  it("400s when the document already has an upload", async () => {
    const res = await postSimulateUpload(
      post("http://x", { clientId: "cl_rivera", docId: "doc_rivera_bank", variant: "correct" }),
    )
    expect(res.status).toBe(400)
  })

  it("400s on an unknown variant and 404s on mismatched ids", async () => {
    const badVariant = await postSimulateUpload(
      post("http://x", { clientId: "cl_rivera", docId: "doc_rivera_w2", variant: "sideways" }),
    )
    expect(badVariant.status).toBe(400)

    const wrongClient = await postSimulateUpload(
      post("http://x", { clientId: "cl_rivera", docId: "doc_chen_bank", variant: "correct" }),
    )
    expect(wrongClient.status).toBe(404)

    const unknownClient = await postSimulateUpload(
      post("http://x", { clientId: "cl_nope", docId: "doc_rivera_w2", variant: "correct" }),
    )
    expect(unknownClient.status).toBe(404)
  })
})
