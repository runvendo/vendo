import { getStore } from "./store"
import { getOrder, recomputeCustomerTotals } from "./orders"
import { badRequestError, conflictError, notFoundError } from "./errors"
import type { Refund, RefundReason } from "./types"

const REFUND_REASONS: RefundReason[] = [
  "duplicate", "defective", "not_as_described", "late_delivery", "changed_mind", "other",
]

export interface ListRefundsInput {
  orderId?: string
  limit?: number
}

export function listRefunds(input: ListRefundsInput = {}): Refund[] {
  const store = getStore()
  let rows = [...store.refunds]

  if (input.orderId) {
    const order = getOrder(input.orderId)
    rows = rows.filter((r) => r.orderId === order.id)
  }

  rows.sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))

  const limit = input.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw badRequestError("limit must be a whole number between 1 and 200.")
  }
  return rows.slice(0, limit)
}

export function getRefund(id: string): Refund {
  const refund = getStore().refunds.find((r) => r.id.toLowerCase() === id.trim().toLowerCase())
  if (!refund) throw notFoundError(`No refund matches "${id}".`)
  return refund
}

/** Money already given back on this order. Failed attempts don't count. */
export function refundedCents(orderId: string): number {
  return getStore()
    .refunds.filter((r) => r.orderId === orderId && r.status !== "failed")
    .reduce((n, r) => n + r.amountCents, 0)
}

/** What's still refundable — the ceiling on any new refund against this order. */
export function refundableCents(idOrNumber: string): number {
  const order = getOrder(idOrNumber)
  return Math.max(0, order.totalCents - refundedCents(order.id))
}

export interface CreateRefundInput {
  orderId: string
  /** Integer cents. Omit to refund everything still outstanding. */
  amountCents?: number
  reason: string
  note?: string
  createdBy: string
}

let refundCounter = 0

/**
 * Crate's irreversible write — real money leaves. Every rejection below is a
 * refusal to move money on a request that doesn't add up, which is why they all
 * happen before a single field is mutated.
 */
export function createRefund(input: CreateRefundInput): Refund {
  const store = getStore()
  const order = getOrder(input.orderId)

  if (order.status === "pending") {
    throw conflictError(`${order.number} was never paid, so there is nothing to refund.`)
  }
  if (order.status === "cancelled") {
    throw conflictError(`${order.number} was cancelled before payment settled.`)
  }

  const reason = input.reason?.trim().toLowerCase() as RefundReason
  if (!REFUND_REASONS.includes(reason)) {
    throw badRequestError(
      `Unknown reason "${input.reason}". Expected one of: ${REFUND_REASONS.join(", ")}.`,
    )
  }

  const outstanding = order.totalCents - refundedCents(order.id)
  if (outstanding <= 0) {
    throw conflictError(`${order.number} has already been refunded in full.`)
  }

  const amountCents = input.amountCents ?? outstanding
  // A positive whole number of cents. Rejects negatives (which would *charge*
  // the customer), zero, fractional cents, and the NaN a junk query param
  // coerces to.
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw badRequestError("amountCents must be a positive whole number of cents.")
  }
  if (amountCents > outstanding) {
    throw badRequestError(
      `Refund of ${fmt(amountCents)} exceeds the ${fmt(outstanding)} still outstanding on ${order.number}.`,
    )
  }

  const refund: Refund = {
    id: `ref_${Date.now().toString(36)}_${refundCounter++}`,
    orderId: order.id,
    amountCents,
    reason,
    status: "succeeded",
    createdAt: new Date().toISOString(),
    createdBy: input.createdBy,
    note: input.note?.trim() || undefined,
  }
  store.refunds.unshift(refund)

  // Fully refunded orders leave the revenue line; partial ones stay, minus
  // nothing — the console shows the refund alongside the original total.
  if (amountCents === outstanding) {
    order.status = "refunded"
    recomputeCustomerTotals(order.customerId)
  }
  return refund
}

function fmt(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}
