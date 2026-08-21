import { describe, it, expect, beforeEach } from "vitest"
import { __reseed, getStore } from "./store"
import { listOrders, getOrder, getOrderDetail, cancelOrder, fulfillOrder } from "./orders"
import { DomainError } from "./errors"

const ANCHOR = new Date("2026-08-07T12:00:00.000Z")

beforeEach(() => {
  __reseed(ANCHOR)
})

describe("listOrders", () => {
  it("returns newest first and honours the limit", () => {
    const rows = listOrders({ limit: 5 })
    expect(rows).toHaveLength(5)
    for (let i = 1; i < rows.length; i++) {
      expect(+new Date(rows[i].placedAt)).toBeLessThanOrEqual(+new Date(rows[i - 1].placedAt))
    }
  })

  it("filters by status", () => {
    const rows = listOrders({ status: "delivered", limit: 200 })
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((o) => o.status === "delivered")).toBe(true)
  })

  it("rejects an unknown status by naming the legal ones", () => {
    try {
      listOrders({ status: "shippped" })
      expect.unreachable("should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError)
      expect((err as DomainError).kind).toBe("bad_request")
      expect((err as DomainError).message).toContain("delivered")
    }
  })

  it("searches by order number and by customer", () => {
    const store = getStore()
    const target = store.orders[0]
    const customer = store.customers.find((c) => c.id === target.customerId)!

    expect(listOrders({ q: target.number.toLowerCase() }).map((o) => o.id)).toContain(target.id)
    const byEmail = listOrders({ q: customer.email, limit: 200 })
    expect(byEmail.length).toBeGreaterThan(0)
    expect(byEmail.every((o) => o.customerId === customer.id)).toBe(true)
  })

  it("rejects a limit outside 1..200", () => {
    expect(() => listOrders({ limit: 0 })).toThrow(DomainError)
    expect(() => listOrders({ limit: 5000 })).toThrow(DomainError)
    expect(() => listOrders({ limit: 2.5 })).toThrow(DomainError)
  })
})

describe("getOrder", () => {
  it("accepts the id or the human number, case-insensitively", () => {
    const store = getStore()
    const order = store.orders[0]
    expect(getOrder(order.id).id).toBe(order.id)
    expect(getOrder(order.number).id).toBe(order.id)
    expect(getOrder(order.number.toLowerCase()).id).toBe(order.id)
  })

  it("404s on an unknown reference", () => {
    try {
      getOrder("CR-9999")
      expect.unreachable("should have thrown")
    } catch (err) {
      expect((err as DomainError).kind).toBe("not_found")
    }
  })

  it("pulls in the customer, address, shipment and refunds", () => {
    const store = getStore()
    const detail = getOrderDetail(store.story.deliveredOrderNumber)
    expect(detail.customer?.id).toBe(store.story.customerId)
    expect(detail.shippingAddress?.customerId).toBe(store.story.customerId)
    expect(detail.shipment).not.toBeNull()
    expect(detail.refunds).toEqual([])
  })
})

describe("cancelOrder", () => {
  it("cancels an order that has not shipped, and drops it from lifetime value", () => {
    const store = getStore()
    const order = store.orders.find((o) => o.status === "paid")!
    const before = store.customers.find((c) => c.id === order.customerId)!.lifetimeValueCents

    const cancelled = cancelOrder(order.number, "customer changed their mind")
    expect(cancelled.status).toBe("cancelled")
    expect(cancelled.notes).toContain("changed their mind")

    const after = store.customers.find((c) => c.id === order.customerId)!.lifetimeValueCents
    expect(after).toBe(before - order.totalCents)
  })

  it("releases the reserved units", () => {
    const store = getStore()
    const order = store.orders.find((o) => o.status === "paid")!
    const line = order.lines[0]
    const before = store.products.find((p) => p.id === line.productId)!.stockReserved

    cancelOrder(order.id)
    const after = store.products.find((p) => p.id === line.productId)!.stockReserved
    expect(after).toBe(Math.max(0, before - line.quantity))
  })

  it("refuses a delivered order and points at the refund instead", () => {
    const store = getStore()
    try {
      cancelOrder(store.story.deliveredOrderNumber)
      expect.unreachable("should have thrown")
    } catch (err) {
      expect((err as DomainError).kind).toBe("conflict")
      expect((err as DomainError).message).toContain("Refund it instead")
    }
  })

  it("refuses to cancel twice", () => {
    const store = getStore()
    const order = store.orders.find((o) => o.status === "paid")!
    cancelOrder(order.id)
    expect(() => cancelOrder(order.id)).toThrow(/already cancelled/)
  })
})

describe("fulfillOrder", () => {
  it("moves paid to fulfilled and is idempotent", () => {
    const order = getStore().orders.find((o) => o.status === "paid")!
    expect(fulfillOrder(order.id).status).toBe("fulfilled")
    expect(fulfillOrder(order.id).status).toBe("fulfilled")
  })

  it("refuses anything that was never paid", () => {
    const store = getStore()
    const order = store.orders.find((o) => o.status === "paid")!
    cancelOrder(order.id)
    expect(() => fulfillOrder(order.id)).toThrow(/Only paid orders/)
  })
})
