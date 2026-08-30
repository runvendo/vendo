import { getStore } from "./store"
import { conflictError, notFoundError, badRequestError } from "./errors"
import type { Order, OrderStatus } from "./types"

const ORDER_STATUSES: OrderStatus[] = [
  "pending", "paid", "fulfilled", "shipped", "delivered", "cancelled", "refunded",
]

export interface ListOrdersInput {
  status?: string
  customerId?: string
  /** Free text — matches order number, customer name, or customer email. */
  q?: string
  limit?: number
}

/**
 * Newest first. Callers (and the agent) reach for this far more than anything
 * else, so it takes the filters people actually ask questions with rather than
 * a generic query language.
 */
export function listOrders(input: ListOrdersInput = {}): Order[] {
  const store = getStore()
  let rows = [...store.orders]

  if (input.status) {
    const status = input.status.trim().toLowerCase() as OrderStatus
    if (!ORDER_STATUSES.includes(status)) {
      throw badRequestError(
        `Unknown status "${input.status}". Expected one of: ${ORDER_STATUSES.join(", ")}.`,
      )
    }
    rows = rows.filter((o) => o.status === status)
  }

  if (input.customerId) {
    rows = rows.filter((o) => o.customerId === input.customerId)
  }

  if (input.q?.trim()) {
    const q = input.q.trim().toLowerCase()
    const matchingCustomers = new Set(
      store.customers
        .filter((c) => c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q))
        .map((c) => c.id),
    )
    rows = rows.filter(
      (o) => o.number.toLowerCase().includes(q) || matchingCustomers.has(o.customerId),
    )
  }

  rows.sort((a, b) => +new Date(b.placedAt) - +new Date(a.placedAt))

  const limit = input.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw badRequestError("limit must be a whole number between 1 and 200.")
  }
  return rows.slice(0, limit)
}

/**
 * Accepts either the internal id (`ord_12`) or the human order number
 * (`CR-1084`), case-insensitively. People — and therefore agents — quote the
 * number off an email; making them translate it first is a pointless failure.
 */
export function findOrder(idOrNumber: string): Order | undefined {
  const key = idOrNumber.trim().toLowerCase()
  return getStore().orders.find(
    (o) => o.id.toLowerCase() === key || o.number.toLowerCase() === key,
  )
}

export function getOrder(idOrNumber: string): Order {
  const order = findOrder(idOrNumber)
  if (!order) throw notFoundError(`No order matches "${idOrNumber}".`)
  return order
}

/** What a single order looks like once you pull in everything hanging off it. */
export function getOrderDetail(idOrNumber: string) {
  const store = getStore()
  const order = getOrder(idOrNumber)
  return {
    ...order,
    customer: store.customers.find((c) => c.id === order.customerId) ?? null,
    shippingAddress: store.addresses.find((a) => a.id === order.shippingAddressId) ?? null,
    shipment: store.shipments.find((s) => s.orderId === order.id) ?? null,
    refunds: store.refunds.filter((r) => r.orderId === order.id),
  }
}

/** Statuses that mean the goods have not left the building yet. */
const CANCELLABLE: OrderStatus[] = ["pending", "paid", "fulfilled"]

export function cancelOrder(idOrNumber: string, reason?: string): Order {
  const order = getOrder(idOrNumber)
  if (order.status === "cancelled") {
    throw conflictError(`${order.number} is already cancelled.`)
  }
  if (!CANCELLABLE.includes(order.status)) {
    // Once it ships, cancelling is a lie — the correct move is a refund, and
    // saying so is more useful to the agent than a bare 409.
    throw conflictError(
      `${order.number} is ${order.status} and can no longer be cancelled. Refund it instead.`,
    )
  }

  order.status = "cancelled"
  if (reason?.trim()) {
    order.notes = order.notes ? `${order.notes}\nCancelled: ${reason.trim()}` : `Cancelled: ${reason.trim()}`
  }
  // Cancelling releases the reservation and takes the order out of the
  // customer's lifetime value — both are derived facts elsewhere in the app,
  // so they have to move together with the status or the console contradicts
  // itself.
  releaseReservations(order)
  recomputeCustomerTotals(order.customerId)
  return order
}

/** paid → fulfilled: picked and packed, not yet handed to a carrier. */
export function fulfillOrder(idOrNumber: string): Order {
  const order = getOrder(idOrNumber)
  if (order.status === "fulfilled") return order
  if (order.status !== "paid") {
    throw conflictError(`Only paid orders can be fulfilled; ${order.number} is ${order.status}.`)
  }
  order.status = "fulfilled"
  return order
}

export function releaseReservations(order: Order) {
  const store = getStore()
  for (const line of order.lines) {
    const product = store.products.find((p) => p.id === line.productId)
    if (product) product.stockReserved = Math.max(0, product.stockReserved - line.quantity)
  }
}

/**
 * Lifetime value counts money Crate actually kept, so cancelled orders never
 * counted and fully refunded ones stop counting. The seed produces neither
 * status at rest, so this agrees with the seeded rollup on a fresh store.
 */
export function recomputeCustomerTotals(customerId: string) {
  const store = getStore()
  const customer = store.customers.find((c) => c.id === customerId)
  if (!customer) return
  const live = store.orders.filter(
    (o) => o.customerId === customerId && o.status !== "cancelled" && o.status !== "refunded",
  )
  customer.orderCount = live.length
  customer.lifetimeValueCents = live.reduce((n, o) => n + o.totalCents, 0)
}
