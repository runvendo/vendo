import { describe, it, expect, beforeEach } from "vitest"
import { __reseed, getStore } from "./store"
import { createRefund, listRefunds, refundableCents, refundedCents } from "./refunds"
import { cancelOrder, getOrder } from "./orders"
import { DomainError } from "./errors"

const ANCHOR = new Date("2026-08-07T12:00:00.000Z")
const BY = "mia@crate.com"

beforeEach(() => {
  __reseed(ANCHOR)
})

describe("createRefund", () => {
  it("refunds the duplicate charge in full and marks the order refunded", () => {
    const store = getStore()
    const order = getOrder(store.story.duplicateOrderNumber)

    const refund = createRefund({
      orderId: order.number,
      reason: "duplicate",
      note: "Charged twice, 3 minutes apart. Delivered copy retained.",
      createdBy: BY,
    })

    expect(refund.amountCents).toBe(order.totalCents)
    expect(refund.status).toBe("succeeded")
    expect(getOrder(order.number).status).toBe("refunded")
    expect(listRefunds({ orderId: order.number })).toHaveLength(1)
  })

  it("drops a fully refunded order out of lifetime value", () => {
    const store = getStore()
    const order = getOrder(store.story.duplicateOrderNumber)
    const before = store.customers.find((c) => c.id === order.customerId)!.lifetimeValueCents

    createRefund({ orderId: order.id, reason: "duplicate", createdBy: BY })

    const after = store.customers.find((c) => c.id === order.customerId)!.lifetimeValueCents
    expect(after).toBe(before - order.totalCents)
  })

  it("allows partial refunds up to the outstanding amount, then stops", () => {
    const store = getStore()
    const order = getOrder(store.story.duplicateOrderNumber)

    createRefund({ orderId: order.id, amountCents: 1_000, reason: "defective", createdBy: BY })
    expect(refundedCents(order.id)).toBe(1_000)
    expect(refundableCents(order.id)).toBe(order.totalCents - 1_000)
    // Partial money back does not close the order.
    expect(getOrder(order.id).status).toBe("paid")

    createRefund({ orderId: order.id, reason: "defective", createdBy: BY })
    expect(refundedCents(order.id)).toBe(order.totalCents)
    expect(getOrder(order.id).status).toBe("refunded")

    expect(() => createRefund({ orderId: order.id, reason: "defective", createdBy: BY }))
      .toThrow(/already been refunded in full/)
  })

  it("refuses to refund more than is outstanding", () => {
    const order = getOrder(getStore().story.duplicateOrderNumber)
    try {
      createRefund({
        orderId: order.id,
        amountCents: order.totalCents + 1,
        reason: "duplicate",
        createdBy: BY,
      })
      expect.unreachable("should have thrown")
    } catch (err) {
      expect((err as DomainError).kind).toBe("bad_request")
      expect((err as DomainError).message).toMatch(/exceeds/)
    }
    // Nothing was written on the way to the rejection.
    expect(listRefunds({ orderId: order.id })).toHaveLength(0)
  })

  it("rejects amounts that are not a positive whole number of cents", () => {
    const order = getOrder(getStore().story.duplicateOrderNumber)
    for (const amountCents of [0, -500, 12.5, Number.NaN]) {
      expect(() => createRefund({ orderId: order.id, amountCents, reason: "other", createdBy: BY }))
        .toThrow(/positive whole number of cents/)
    }
  })

  it("rejects an unknown reason", () => {
    const order = getOrder(getStore().story.duplicateOrderNumber)
    expect(() => createRefund({ orderId: order.id, reason: "vibes", createdBy: BY }))
      .toThrow(/Unknown reason/)
  })

  it("refuses orders that never took money", () => {
    const store = getStore()
    const order = store.orders.find((o) => o.status === "paid" && o.number !== store.story.duplicateOrderNumber)!
    cancelOrder(order.id)
    try {
      createRefund({ orderId: order.id, reason: "duplicate", createdBy: BY })
      expect.unreachable("should have thrown")
    } catch (err) {
      expect((err as DomainError).kind).toBe("conflict")
    }
  })

  it("404s on an unknown order", () => {
    expect(() => createRefund({ orderId: "CR-9999", reason: "other", createdBy: BY }))
      .toThrow(/No order matches/)
  })
})
