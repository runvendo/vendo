import { describe, it, expect } from "vitest"
import { buildSeed } from "../seed"

const anchor = new Date("2026-07-02T09:00:00-07:00")

describe("buildSeed determinism", () => {
  it("produces identical data for the same anchor", () => {
    const a = buildSeed(anchor)
    const b = buildSeed(new Date(anchor))
    expect(a).toEqual(b)
  })
})

describe("opening invariants", () => {
  const data = buildSeed(anchor)

  it("seeds 12 clients", () => {
    expect(data.clients.length).toBe(12)
  })

  it("has exactly 8 clients with at least one missing document", () => {
    const missing = data.clients.filter(c =>
      data.documents.some(d => d.clientId === c.id && d.status === "missing"),
    )
    expect(missing.length).toBe(8)
  })

  it("completes the other 4 clients (all documents verified)", () => {
    const complete = data.clients.filter(c =>
      data.documents
        .filter(d => d.clientId === c.id)
        .every(d => d.status === "verified"),
    )
    expect(complete.length).toBe(4)
  })

  it("includes the three demo-script clients with correct entity types", () => {
    const byName = (name: string) => data.clients.find(c => c.businessName === name)
    expect(byName("Blue Bottle Coffee")?.entityType).toBe("s_corp")
    expect(byName("Linear")?.entityType).toBe("sole_prop")
    expect(byName("Sweetgreen")?.entityType).toBe("partnership")
  })

  it("gives every client 4 to 6 document requests", () => {
    for (const c of data.clients) {
      const docs = data.documents.filter(d => d.clientId === c.id)
      expect(docs.length).toBeGreaterThanOrEqual(4)
      expect(docs.length).toBeLessThanOrEqual(6)
    }
  })

  it("seeds mixed document statuses for texture", () => {
    const statuses = new Set(data.documents.map(d => d.status))
    expect(statuses.has("missing")).toBe(true)
    expect(statuses.has("received")).toBe(true)
    expect(statuses.has("needs_review")).toBe(true)
    expect(statuses.has("verified")).toBe(true)
  })

  it("attaches a file to every uploaded document and none to missing ones", () => {
    for (const d of data.documents) {
      if (d.status === "missing") {
        expect(d.file).toBeUndefined()
      } else {
        expect(d.file?.name).toBeTruthy()
        expect(Number.isNaN(Date.parse(d.file!.uploadedAt))).toBe(false)
      }
    }
  })

  it("seeds every filing deadline in the future relative to the anchor", () => {
    for (const c of data.clients) {
      expect(+new Date(c.filingDeadline)).toBeGreaterThan(+anchor)
    }
  })

  it("puts at least two clients inside the 3-day deadline window and staggers the rest within ~11 weeks", () => {
    const days = data.clients
      .map(c => (+new Date(c.filingDeadline) - +anchor) / 86_400_000)
      .sort((a, b) => a - b)
    // Blue Bottle + Linear keep deadline and document-chase views meaningfully urgent.
    expect(days.filter(d => d <= 3.5).length).toBeGreaterThanOrEqual(2)
    expect(days[0]).toBeGreaterThan(0)
    expect(days[days.length - 1]).toBeLessThanOrEqual(77)
  })

  it("plus-addresses every contact email to the demo inbox (real sends must land in an inbox we own)", () => {
    for (const c of data.clients) {
      expect(c.contactEmail).toMatch(/^yousef\+[a-z]+@vendo\.run$/)
    }
  })

  it("seeds 4 staff including the signed-in persona Maya Alvarez", () => {
    expect(data.staff.length).toBe(4)
    const maya = data.staff.find(s => s.name === "Maya Alvarez")
    expect(maya?.role).toBe("Account Manager")
    expect(maya?.initials).toBe("MA")
  })

  it("assigns every client to a seeded staff member", () => {
    const staffIds = new Set(data.staff.map(s => s.id))
    for (const c of data.clients) expect(staffIds.has(c.assigneeId)).toBe(true)
  })

  it("seeds lived-in message threads (2-5 messages) for most clients", () => {
    const threaded = data.clients.filter(c => {
      const msgs = data.messages.filter(m => m.clientId === c.id)
      return msgs.length >= 2 && msgs.length <= 5
    })
    expect(threaded.length).toBeGreaterThanOrEqual(8)
    for (const m of data.messages) {
      expect(m.body.length).toBeGreaterThan(20)
      expect(+new Date(m.sentAt)).toBeLessThanOrEqual(+anchor)
    }
  })

  it("seeds about 10 recent activity events, newest first", () => {
    expect(data.activity.length).toBeGreaterThanOrEqual(8)
    expect(data.activity.length).toBeLessThanOrEqual(14)
    for (let i = 1; i < data.activity.length; i++) {
      expect(+new Date(data.activity[i - 1].at)).toBeGreaterThanOrEqual(
        +new Date(data.activity[i].at),
      )
    }
    for (const e of data.activity) {
      expect(+new Date(e.at)).toBeLessThanOrEqual(+anchor)
    }
  })
})
