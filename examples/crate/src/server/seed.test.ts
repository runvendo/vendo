import { describe, it, expect } from "vitest"
import { buildSeed } from "./seed"

const ANCHOR = new Date("2026-08-07T12:00:00.000Z")

describe("seed", () => {
  it("is deterministic for a fixed anchor", () => {
    const a = buildSeed(ANCHOR)
    const b = buildSeed(ANCHOR)
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b))
  })

  it("produces a coherent catalogue and roster", () => {
    const s = buildSeed(ANCHOR)
    expect(s.products).toHaveLength(10)
    expect(s.customers).toHaveLength(12)
    expect(s.staff.map(u => u.role).sort()).toEqual(["admin", "agent"])
    // Every customer's default address exists and belongs to them.
    for (const c of s.customers) {
      const addr = s.addresses.find(a => a.id === c.defaultAddressId)
      expect(addr, `address for ${c.id}`).toBeDefined()
      expect(addr!.customerId).toBe(c.id)
    }
  })

  it("keeps money arithmetic exact, in integer cents", () => {
    const s = buildSeed(ANCHOR)
    for (const o of s.orders) {
      const lineSum = o.lines.reduce((n, l) => n + l.lineTotalCents, 0)
      expect(o.subtotalCents).toBe(lineSum)
      expect(o.totalCents).toBe(o.subtotalCents + o.shippingCents + o.taxCents)
      expect(Number.isInteger(o.totalCents)).toBe(true)
      for (const l of o.lines) {
        expect(l.lineTotalCents).toBe(l.unitPriceCents * l.quantity)
      }
    }
  })

  it("gives every order a unique number and id", () => {
    const s = buildSeed(ANCHOR)
    expect(new Set(s.orders.map(o => o.number)).size).toBe(s.orders.length)
    expect(new Set(s.orders.map(o => o.id)).size).toBe(s.orders.length)
  })

  it("numbers orders monotonically with time", () => {
    const s = buildSeed(ANCHOR)
    const seq = (o: { number: string }) => Number(o.number.replace("CR-", ""))
    const sorted = [...s.orders].sort((a, b) => seq(a) - seq(b))
    for (let i = 1; i < sorted.length; i++) {
      expect(
        new Date(sorted[i].placedAt).getTime(),
      ).toBeGreaterThanOrEqual(new Date(sorted[i - 1].placedAt).getTime())
    }
  })

  it("stages the duplicate-charge story", () => {
    const s = buildSeed(ANCHOR)
    const delivered = s.orders.find(o => o.number === s.story.deliveredOrderNumber)!
    const duplicate = s.orders.find(o => o.number === s.story.duplicateOrderNumber)!

    // Same customer, same single product, minutes apart.
    expect(delivered.customerId).toBe(s.story.customerId)
    expect(duplicate.customerId).toBe(s.story.customerId)
    expect(delivered.lines).toHaveLength(1)
    expect(duplicate.lines).toHaveLength(1)
    expect(duplicate.lines[0].sku).toBe(delivered.lines[0].sku)
    expect(delivered.totalCents).toBe(duplicate.totalCents)

    const gapMs = new Date(duplicate.placedAt).getTime() - new Date(delivered.placedAt).getTime()
    expect(gapMs).toBe(3 * 60_000)

    // One shipped and landed; the other never left. That asymmetry is the
    // whole point — it's what makes the refund the correct resolution.
    expect(delivered.status).toBe("delivered")
    expect(duplicate.status).toBe("paid")
    expect(s.shipments.some(sh => sh.orderId === delivered.id)).toBe(true)
    expect(s.shipments.some(sh => sh.orderId === duplicate.id)).toBe(false)

    // Distinct charges — this really was billed twice.
    expect(duplicate.paymentRef).not.toBe(delivered.paymentRef)
  })

  it("never lists the same product on two lines of one order", () => {
    const s = buildSeed(ANCHOR)
    for (const o of s.orders) {
      const skus = o.lines.map(l => l.sku)
      expect(new Set(skus).size, `${o.number} repeats a sku`).toBe(skus.length)
      for (const l of o.lines) expect(l.quantity).toBeGreaterThan(0)
    }
  })

  it("gives each order at most one shipment, with unique ids", () => {
    const s = buildSeed(ANCHOR)
    expect(new Set(s.shipments.map(sh => sh.id)).size).toBe(s.shipments.length)

    const perOrder = new Map<string, number>()
    for (const sh of s.shipments) {
      perOrder.set(sh.orderId, (perOrder.get(sh.orderId) ?? 0) + 1)
      // Every shipment points at a real order.
      expect(s.orders.some(o => o.id === sh.orderId), `order for ${sh.id}`).toBe(true)
    }
    for (const [orderId, n] of perOrder) {
      expect(n, `shipments for ${orderId}`).toBe(1)
    }
  })

  it("only ships orders that have actually moved", () => {
    const s = buildSeed(ANCHOR)
    const shipped = new Set(s.shipments.map(sh => sh.orderId))
    for (const o of s.orders) {
      if (o.status === "cancelled" || o.status === "paid" || o.status === "pending") {
        expect(shipped.has(o.id), `${o.number} (${o.status}) must not have a shipment`).toBe(false)
      }
    }
  })

  it("keeps shipment event timelines ordered", () => {
    const s = buildSeed(ANCHOR)
    for (const sh of s.shipments) {
      expect(sh.events.length).toBeGreaterThan(0)
      for (let i = 1; i < sh.events.length; i++) {
        expect(new Date(sh.events[i].at).getTime())
          .toBeGreaterThanOrEqual(new Date(sh.events[i - 1].at).getTime())
      }
      // A delivered shipment records when, and says so in its timeline.
      if (sh.status === "delivered") {
        expect(sh.deliveredAt).toBeDefined()
        expect(sh.events.some(e => e.status === "delivered")).toBe(true)
      }
    }
  })

  it("excludes cancelled orders from lifetime value", () => {
    const s = buildSeed(ANCHOR)
    for (const c of s.customers) {
      const live = s.orders.filter(o => o.customerId === c.id && o.status !== "cancelled")
      expect(c.orderCount).toBe(live.length)
      expect(c.lifetimeValueCents).toBe(live.reduce((n, o) => n + o.totalCents, 0))
    }
  })

  it("leaves one product below its reorder point", () => {
    const s = buildSeed(ANCHOR)
    expect(s.products.some(p => p.stockOnHand < p.reorderPoint)).toBe(true)
  })
})
