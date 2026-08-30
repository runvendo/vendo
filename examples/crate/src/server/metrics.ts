import { getStore } from "./store"
import { availableUnits } from "./inventory"

const DAY_MS = 86_400_000

/**
 * The numbers the console opens on, and the ones the agent needs to answer
 * "how are we doing today?" in one call instead of six.
 */
export function dashboardSummary(now: Date = new Date()) {
  const store = getStore()
  const since = now.getTime() - 7 * DAY_MS

  const recent = store.orders.filter((o) => +new Date(o.placedAt) >= since)
  const earned = recent.filter((o) => o.status !== "cancelled" && o.status !== "refunded")

  const awaitingFulfilment = store.orders.filter((o) => o.status === "paid")
  const problemShipments = store.shipments.filter(
    (s) => s.status === "exception" || s.status === "returned",
  )
  const lowStock = store.products.filter((p) => availableUnits(p) <= p.reorderPoint)

  return {
    ordersLast7Days: recent.length,
    revenueLast7DaysCents: earned.reduce((n, o) => n + o.totalCents, 0),
    awaitingFulfilment: awaitingFulfilment.length,
    problemShipments: problemShipments.length,
    lowStockProducts: lowStock.length,
    refundedLast7DaysCents: store.refunds
      .filter((r) => r.status !== "failed" && +new Date(r.createdAt) >= since)
      .reduce((n, r) => n + r.amountCents, 0),
  }
}

/** Everything a human should look at before anything else. */
export function needsAttention() {
  const store = getStore()
  return {
    unfulfilledOrders: store.orders
      .filter((o) => o.status === "paid")
      .sort((a, b) => +new Date(a.placedAt) - +new Date(b.placedAt)) // oldest first: worst first
      .slice(0, 8),
    problemShipments: store.shipments
      .filter((s) => s.status === "exception" || s.status === "returned")
      .slice(0, 8),
    lowStock: store.products
      .filter((p) => availableUnits(p) <= p.reorderPoint)
      .sort((a, b) => availableUnits(a) - availableUnits(b))
      .slice(0, 8),
  }
}
