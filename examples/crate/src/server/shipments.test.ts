import { describe, it, expect, beforeEach } from "vitest"
import { __reseed, getStore } from "./store"
import {
  addShipmentEvent, createShipment, getShipment, getShipmentDetail, listShipments,
} from "./shipments"
import { getOrder } from "./orders"
import { DomainError } from "./errors"

const ANCHOR = new Date("2026-08-07T12:00:00.000Z")
const BY = "mia@crate.com"

beforeEach(() => {
  __reseed(ANCHOR)
})

describe("listShipments", () => {
  it("isolates the ones a human has to deal with", () => {
    const problems = listShipments({ problemsOnly: true, limit: 200 })
    expect(problems.length).toBeGreaterThan(0)
    expect(problems.every((s) => s.status === "exception" || s.status === "returned")).toBe(true)
  })

  it("rejects an unknown status", () => {
    expect(() => listShipments({ status: "lost" })).toThrow(/Unknown status/)
  })
})

describe("getShipment", () => {
  it("resolves by shipment id, tracking number, or the order it belongs to", () => {
    const store = getStore()
    const shipment = store.shipments[0]
    const order = store.orders.find((o) => o.id === shipment.orderId)!

    expect(getShipment(shipment.id).id).toBe(shipment.id)
    expect(getShipment(shipment.trackingNumber).id).toBe(shipment.id)
    expect(getShipment(order.number).id).toBe(shipment.id)
  })

  it("404s when the order exists but never shipped", () => {
    const store = getStore()
    try {
      getShipment(store.story.duplicateOrderNumber)
      expect.unreachable("should have thrown")
    } catch (err) {
      expect((err as DomainError).kind).toBe("not_found")
    }
  })

  it("carries the order and customer for the tracking view", () => {
    const store = getStore()
    const detail = getShipmentDetail(store.story.deliveredOrderNumber)
    expect(detail.order?.number).toBe(store.story.deliveredOrderNumber)
    expect(detail.customer?.id).toBe(store.story.customerId)
  })
})

describe("createShipment", () => {
  it("labels a paid order and moves both sides together", () => {
    const store = getStore()
    const order = store.orders.find((o) => o.status === "paid")!
    const line = order.lines[0]
    const onHand = store.products.find((p) => p.id === line.productId)!.stockOnHand

    const shipment = createShipment({ orderId: order.number, carrier: "FedEx", createdBy: BY })

    expect(shipment.status).toBe("label_created")
    expect(shipment.carrier).toBe("FedEx")
    expect(shipment.trackingNumber).toMatch(/^1Z/)
    expect(getOrder(order.number).status).toBe("shipped")
    // The units left the building.
    expect(store.products.find((p) => p.id === line.productId)!.stockOnHand)
      .toBe(onHand - line.quantity)
  })

  it("refuses a second shipment for the same order", () => {
    const order = getStore().orders.find((o) => o.status === "paid")!
    createShipment({ orderId: order.id, createdBy: BY })
    try {
      createShipment({ orderId: order.id, createdBy: BY })
      expect.unreachable("should have thrown")
    } catch (err) {
      expect((err as DomainError).kind).toBe("conflict")
      expect((err as DomainError).message).toMatch(/already has shipment/)
    }
  })

  it("refuses to ship an order that is not paid or fulfilled", () => {
    const store = getStore()
    expect(() => createShipment({ orderId: store.story.deliveredOrderNumber, createdBy: BY }))
      .toThrow(DomainError)
  })

  it("rejects an unknown carrier", () => {
    const order = getStore().orders.find((o) => o.status === "paid")!
    expect(() => createShipment({ orderId: order.id, carrier: "Owl Post", createdBy: BY }))
      .toThrow(/Unknown carrier/)
  })
})

describe("addShipmentEvent", () => {
  it("appends a scan and follows it with the shipment's own status", () => {
    const order = getStore().orders.find((o) => o.status === "paid")!
    const shipment = createShipment({ orderId: order.id, createdBy: BY })
    const before = shipment.events.length

    const updated = addShipmentEvent({
      shipmentId: shipment.id,
      status: "in_transit",
      location: "Reno, NV",
    })
    expect(updated.events).toHaveLength(before + 1)
    expect(updated.status).toBe("in_transit")
    expect(updated.events.at(-1)!.location).toBe("Reno, NV")
  })

  it("closes out the order when the package lands", () => {
    const order = getStore().orders.find((o) => o.status === "paid")!
    const shipment = createShipment({ orderId: order.id, createdBy: BY })

    const delivered = addShipmentEvent({ shipmentId: shipment.id, status: "delivered" })
    expect(delivered.deliveredAt).toBeDefined()
    expect(getOrder(order.id).status).toBe("delivered")
  })

  it("refuses to move a delivered shipment", () => {
    const store = getStore()
    const shipment = store.shipments.find((s) => s.status === "delivered")!
    expect(() => addShipmentEvent({ shipmentId: shipment.id, status: "in_transit" }))
      .toThrow(/already delivered/)
  })
})
