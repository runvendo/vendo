import { describe, it, expect, beforeEach } from "vitest"
import { __reseed, getStore } from "./store"
import { adjustStock, availableUnits, getProduct, getProductDetail, listProducts } from "./inventory"
import { DomainError } from "./errors"

const ANCHOR = new Date("2026-08-07T12:00:00.000Z")
const BY = "yousef@crate.com"

beforeEach(() => {
  __reseed(ANCHOR)
})

describe("listProducts", () => {
  it("searches sku, title and category", () => {
    const espresso = getProduct("CRT-ESP-01")
    expect(listProducts({ q: "crt-esp" }).map((p) => p.id)).toContain(espresso.id)
    expect(listProducts({ q: "espresso" }).map((p) => p.id)).toContain(espresso.id)
  })

  it("surfaces what needs reordering", () => {
    const low = listProducts({ lowStock: true })
    expect(low.length).toBeGreaterThan(0)
    expect(low.every((p) => availableUnits(p) <= p.reorderPoint)).toBe(true)
  })
})

describe("getProduct", () => {
  it("accepts the id or the sku", () => {
    const bySku = getProduct("CRT-ESP-01")
    expect(getProduct(bySku.id).id).toBe(bySku.id)
    expect(getProduct("crt-esp-01").id).toBe(bySku.id)
  })

  it("404s on an unknown sku", () => {
    expect(() => getProduct("CRT-NOPE-99")).toThrow(/No product matches/)
  })

  it("reports availability and history alongside the product", () => {
    const detail = getProductDetail("CRT-ESP-01")
    expect(detail.available).toBe(detail.stockOnHand - detail.stockReserved)
    expect(detail.belowReorderPoint).toBe(true)
    expect(detail.adjustments.length).toBeGreaterThan(0)
  })
})

describe("adjustStock", () => {
  it("applies a signed delta and records why", () => {
    const before = getProduct("CRT-ESP-01").stockOnHand
    const { product, adjustment } = adjustStock({
      productId: "CRT-ESP-01",
      delta: 12,
      reason: "Purchase order PO-4417 received",
      createdBy: BY,
    })

    expect(product.stockOnHand).toBe(before + 12)
    expect(adjustment.delta).toBe(12)
    expect(adjustment.createdBy).toBe(BY)
    // Newest first, so the console shows the change that just happened.
    expect(getStore().adjustments[0].id).toBe(adjustment.id)
  })

  it("refuses to take stock negative, and leaves it untouched", () => {
    const before = getProduct("CRT-ESP-01").stockOnHand
    try {
      adjustStock({ productId: "CRT-ESP-01", delta: -(before + 1), reason: "damage", createdBy: BY })
      expect.unreachable("should have thrown")
    } catch (err) {
      expect((err as DomainError).kind).toBe("bad_request")
    }
    expect(getProduct("CRT-ESP-01").stockOnHand).toBe(before)
  })

  it("rejects a no-op or fractional delta", () => {
    for (const delta of [0, 1.5, Number.NaN]) {
      expect(() => adjustStock({ productId: "CRT-ESP-01", delta, reason: "count", createdBy: BY }))
        .toThrow(/non-zero whole number/)
    }
  })

  it("insists on a reason", () => {
    expect(() => adjustStock({ productId: "CRT-ESP-01", delta: 1, reason: "   ", createdBy: BY }))
      .toThrow(/reason is required/)
  })
})
