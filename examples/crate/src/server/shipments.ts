import { getStore } from "./store"
import { getOrder } from "./orders"
import { badRequestError, conflictError, notFoundError } from "./errors"
import type { Shipment, ShipmentStatus } from "./types"

const SHIPMENT_STATUSES: ShipmentStatus[] = [
  "label_created", "in_transit", "out_for_delivery", "delivered", "exception", "returned",
]

const CARRIERS = ["UPS", "USPS", "FedEx"]

export interface ListShipmentsInput {
  status?: string
  /** Only shipments needing a human — exceptions and returns. */
  problemsOnly?: boolean
  limit?: number
}

export function listShipments(input: ListShipmentsInput = {}): Shipment[] {
  const store = getStore()
  let rows = [...store.shipments]

  if (input.status) {
    const status = input.status.trim().toLowerCase() as ShipmentStatus
    if (!SHIPMENT_STATUSES.includes(status)) {
      throw badRequestError(
        `Unknown status "${input.status}". Expected one of: ${SHIPMENT_STATUSES.join(", ")}.`,
      )
    }
    rows = rows.filter((s) => s.status === status)
  }
  if (input.problemsOnly) {
    rows = rows.filter((s) => s.status === "exception" || s.status === "returned")
  }

  rows.sort((a, b) => +new Date(b.shippedAt ?? 0) - +new Date(a.shippedAt ?? 0))

  const limit = input.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw badRequestError("limit must be a whole number between 1 and 200.")
  }
  return rows.slice(0, limit)
}

/** Shipment id, tracking number, or the order id/number it belongs to. */
export function findShipment(key: string): Shipment | undefined {
  const store = getStore()
  const needle = key.trim().toLowerCase()
  const direct = store.shipments.find(
    (s) => s.id.toLowerCase() === needle || s.trackingNumber.toLowerCase() === needle,
  )
  if (direct) return direct

  const order = store.orders.find(
    (o) => o.id.toLowerCase() === needle || o.number.toLowerCase() === needle,
  )
  return order ? store.shipments.find((s) => s.orderId === order.id) : undefined
}

export function getShipment(key: string): Shipment {
  const shipment = findShipment(key)
  if (!shipment) throw notFoundError(`No shipment matches "${key}".`)
  return shipment
}

export function getShipmentDetail(key: string) {
  const store = getStore()
  const shipment = getShipment(key)
  const order = store.orders.find((o) => o.id === shipment.orderId) ?? null
  return {
    ...shipment,
    order,
    customer: order ? store.customers.find((c) => c.id === order.customerId) ?? null : null,
  }
}

export interface CreateShipmentInput {
  orderId: string
  carrier?: string
  createdBy: string
}

let shipmentCounter = 0

/**
 * Hands a packed order to a carrier: creates the label and moves the order to
 * `shipped`. Both sides move together — an order marked shipped with nothing to
 * track is the bug this exists to prevent.
 */
export function createShipment(input: CreateShipmentInput): Shipment {
  const store = getStore()
  const order = getOrder(input.orderId)

  const existing = store.shipments.find((s) => s.orderId === order.id)
  if (existing) {
    throw conflictError(`${order.number} already has shipment ${existing.id}.`)
  }
  if (order.status !== "paid" && order.status !== "fulfilled") {
    throw conflictError(
      `${order.number} is ${order.status}; only paid or fulfilled orders can ship.`,
    )
  }

  const carrier = input.carrier?.trim() || CARRIERS[0]
  if (!CARRIERS.some((c) => c.toLowerCase() === carrier.toLowerCase())) {
    throw badRequestError(`Unknown carrier "${carrier}". Expected one of: ${CARRIERS.join(", ")}.`)
  }

  const now = new Date()
  const shipment: Shipment = {
    id: `shp_new_${Date.now().toString(36)}_${shipmentCounter++}`,
    orderId: order.id,
    carrier: CARRIERS.find((c) => c.toLowerCase() === carrier.toLowerCase())!,
    trackingNumber: `1Z${Math.floor(Math.random() * 1e15).toString(36).toUpperCase()}`,
    status: "label_created",
    shippedAt: now.toISOString(),
    estimatedDelivery: new Date(now.getTime() + 48 * 3_600_000).toISOString(),
    events: [{ at: now.toISOString(), status: "label_created", location: "Portland, OR" }],
  }

  store.shipments.unshift(shipment)
  order.status = "shipped"
  // The units are out the door: they stop being reserved and leave on-hand.
  for (const line of order.lines) {
    const product = store.products.find((p) => p.id === line.productId)
    if (!product) continue
    product.stockReserved = Math.max(0, product.stockReserved - line.quantity)
    product.stockOnHand = Math.max(0, product.stockOnHand - line.quantity)
  }
  return shipment
}

export interface AddShipmentEventInput {
  shipmentId: string
  status: string
  location?: string
  detail?: string
}

/** Carrier scans arrive out here; the shipment's own status follows the latest one. */
export function addShipmentEvent(input: AddShipmentEventInput): Shipment {
  const shipment = getShipment(input.shipmentId)
  const status = input.status?.trim().toLowerCase() as ShipmentStatus
  if (!SHIPMENT_STATUSES.includes(status)) {
    throw badRequestError(
      `Unknown status "${input.status}". Expected one of: ${SHIPMENT_STATUSES.join(", ")}.`,
    )
  }
  if (shipment.status === "delivered") {
    throw conflictError(`${shipment.id} is already delivered.`)
  }

  const at = new Date().toISOString()
  shipment.events.push({
    at,
    status,
    location: input.location?.trim() || undefined,
    detail: input.detail?.trim() || undefined,
  })
  shipment.status = status
  if (status === "delivered") {
    shipment.deliveredAt = at
    const order = getStore().orders.find((o) => o.id === shipment.orderId)
    if (order && order.status === "shipped") order.status = "delivered"
  }
  return shipment
}
