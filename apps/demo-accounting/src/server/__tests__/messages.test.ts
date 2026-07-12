import { describe, it, expect, beforeEach } from "vitest"
import { __reseed, getStore } from "../store"
import { DomainError } from "../errors"
import { sendMessage } from "../messages"
import { recordActivity } from "../activity"

const anchor = new Date("2026-07-02T09:00:00-07:00")

beforeEach(() => {
  __reseed(anchor)
})

describe("sendMessage", () => {
  it("appends a firm message to the client thread", () => {
    const client = getStore().clients[0]
    const before = getStore().messages.filter(m => m.clientId === client.id).length

    const msg = sendMessage(
      client.id,
      "firm",
      "Maya Alvarez",
      "Quick reminder: we still need your June bank statements to keep your filing on track.",
    )

    expect(msg.direction).toBe("firm")
    expect(msg.author).toBe("Maya Alvarez")
    expect(Number.isNaN(Date.parse(msg.sentAt))).toBe(false)
    const after = getStore().messages.filter(m => m.clientId === client.id)
    expect(after.length).toBe(before + 1)
    expect(after[after.length - 1].id).toBe(msg.id)
  })

  it("records a message_sent activity event", () => {
    const client = getStore().clients[0]
    sendMessage(client.id, "client", client.contactName, "Just sent those over through the portal.")
    const latest = getStore().activity[0]
    expect(latest.type).toBe("message_sent")
    expect(latest.clientId).toBe(client.id)
  })

  it("throws a typed not_found error for an unknown client", () => {
    try {
      sendMessage("cl_nope", "firm", "Maya Alvarez", "Hello there")
      expect.unreachable("unknown client must throw")
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError)
      expect((err as DomainError).code).toBe("not_found")
    }
  })
})

describe("recordActivity", () => {
  it("prepends events with unique ids", () => {
    const a = recordActivity("deadline_approaching", "Filing deadline in 15 days", undefined)
    const b = recordActivity("document_verified", "W-2 verified for Chen Consulting", "cl_chen")
    const activity = getStore().activity
    expect(activity[0].id).toBe(b.id)
    expect(activity[1].id).toBe(a.id)
    expect(a.id).not.toBe(b.id)
  })
})
