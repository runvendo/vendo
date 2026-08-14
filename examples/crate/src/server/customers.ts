import { getStore } from "./store"
import { badRequestError, notFoundError } from "./errors"
import type { Customer } from "./types"

export interface ListCustomersInput {
  /** Free text — matches name, email, or phone. */
  q?: string
  limit?: number
}

export function listCustomers(input: ListCustomersInput = {}): Customer[] {
  const store = getStore()
  let rows = [...store.customers]

  if (input.q?.trim()) {
    const q = input.q.trim().toLowerCase()
    rows = rows.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.email.toLowerCase().includes(q) ||
        (c.phone ?? "").toLowerCase().includes(q),
    )
  }

  rows.sort((a, b) => b.lifetimeValueCents - a.lifetimeValueCents)

  const limit = input.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw badRequestError("limit must be a whole number between 1 and 200.")
  }
  return rows.slice(0, limit)
}

/** Id or email — support asks by email, the console links by id. */
export function findCustomer(idOrEmail: string): Customer | undefined {
  const key = idOrEmail.trim().toLowerCase()
  return getStore().customers.find(
    (c) => c.id.toLowerCase() === key || c.email.toLowerCase() === key,
  )
}

export function getCustomer(idOrEmail: string): Customer {
  const customer = findCustomer(idOrEmail)
  if (!customer) throw notFoundError(`No customer matches "${idOrEmail}".`)
  return customer
}

/** The support view: who they are, where things ship, and what they've bought. */
export function getCustomerDetail(idOrEmail: string) {
  const store = getStore()
  const customer = getCustomer(idOrEmail)
  const orders = store.orders
    .filter((o) => o.customerId === customer.id)
    .sort((a, b) => +new Date(b.placedAt) - +new Date(a.placedAt))

  return {
    ...customer,
    addresses: store.addresses.filter((a) => a.customerId === customer.id),
    orders,
    refunds: store.refunds.filter((r) => orders.some((o) => o.id === r.orderId)),
  }
}

/** Support's scratchpad — "called about a missing package, promised a callback". */
export function appendCustomerNote(idOrEmail: string, note: string, author: string): Customer {
  const customer = getCustomer(idOrEmail)
  const body = note?.trim()
  if (!body) throw badRequestError("A note cannot be empty.")

  const stamp = `${new Date().toISOString().slice(0, 10)} ${author}: ${body}`
  customer.notes = customer.notes ? `${customer.notes}\n${stamp}` : stamp
  return customer
}
