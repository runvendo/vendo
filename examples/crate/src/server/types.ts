// Crate's domain. Money is always integer cents — never floats.

export type OrderStatus =
  | "pending" | "paid" | "fulfilled" | "shipped" | "delivered" | "cancelled" | "refunded"

export type ShipmentStatus =
  | "label_created" | "in_transit" | "out_for_delivery" | "delivered" | "exception" | "returned"

export type RefundReason =
  | "duplicate" | "defective" | "not_as_described" | "late_delivery" | "changed_mind" | "other"

export type RefundStatus = "pending" | "succeeded" | "failed"

export type Channel = "web" | "mobile" | "phone" | "marketplace"

export interface Address {
  id: string
  customerId: string
  line1: string
  line2?: string
  city: string
  region: string
  postalCode: string
  country: string
}

export interface Customer {
  id: string
  name: string
  email: string
  phone?: string
  createdAt: string            // ISO 8601
  defaultAddressId: string
  lifetimeValueCents: number
  orderCount: number
  notes?: string
}

export interface Product {
  id: string
  sku: string
  title: string
  description: string
  priceCents: number
  category: string
  stockOnHand: number
  stockReserved: number
  reorderPoint: number
}

export interface OrderLine {
  id: string
  orderId: string
  productId: string
  sku: string
  title: string
  quantity: number
  unitPriceCents: number
  lineTotalCents: number
}

export interface Order {
  id: string
  number: string               // human-facing, e.g. "CR-1042"
  customerId: string
  status: OrderStatus
  placedAt: string             // ISO 8601
  currency: "USD"
  subtotalCents: number
  shippingCents: number
  taxCents: number
  totalCents: number
  shippingAddressId: string
  paymentRef: string           // processor charge id
  channel: Channel
  lines: OrderLine[]
  notes?: string
}

export interface ShipmentEvent {
  at: string                   // ISO 8601
  status: ShipmentStatus
  location?: string
  detail?: string
}

export interface Shipment {
  id: string
  orderId: string
  carrier: string
  trackingNumber: string
  status: ShipmentStatus
  shippedAt?: string
  estimatedDelivery?: string
  deliveredAt?: string
  events: ShipmentEvent[]
}

export interface Refund {
  id: string
  orderId: string
  amountCents: number
  reason: RefundReason
  status: RefundStatus
  createdAt: string
  createdBy: string            // agent id or staff email
  note?: string
}

export interface StockAdjustment {
  id: string
  productId: string
  delta: number                // signed units
  reason: string
  createdAt: string
  createdBy: string
}

/** A Crate staff member. Seeded; Crate owns its own roster. */
export interface StaffUser {
  id: string
  subject: string              // maps to the auth provider's subject claim
  email: string
  display: string
  role: "admin" | "agent"
}
