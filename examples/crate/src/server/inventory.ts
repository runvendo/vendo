import { getStore } from "./store"
import { badRequestError, notFoundError } from "./errors"
import type { Product, StockAdjustment } from "./types"

export interface ListProductsInput {
  /** Free text — matches sku, title, or category. */
  q?: string
  category?: string
  /** Only products at or under their reorder point. */
  lowStock?: boolean
  limit?: number
}

/** Reserved units are spoken for by unshipped orders; only the rest is sellable. */
export function availableUnits(product: Product): number {
  return Math.max(0, product.stockOnHand - product.stockReserved)
}

export function listProducts(input: ListProductsInput = {}): Product[] {
  const store = getStore()
  let rows = [...store.products]

  if (input.q?.trim()) {
    const q = input.q.trim().toLowerCase()
    rows = rows.filter(
      (p) =>
        p.sku.toLowerCase().includes(q) ||
        p.title.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q),
    )
  }
  if (input.category?.trim()) {
    const category = input.category.trim().toLowerCase()
    rows = rows.filter((p) => p.category.toLowerCase() === category)
  }
  if (input.lowStock) {
    rows = rows.filter((p) => availableUnits(p) <= p.reorderPoint)
  }

  rows.sort((a, b) => a.title.localeCompare(b.title))

  const limit = input.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw badRequestError("limit must be a whole number between 1 and 200.")
  }
  return rows.slice(0, limit)
}

/** Id or SKU — a purchase order quotes the SKU, the console links by id. */
export function findProduct(idOrSku: string): Product | undefined {
  const key = idOrSku.trim().toLowerCase()
  return getStore().products.find(
    (p) => p.id.toLowerCase() === key || p.sku.toLowerCase() === key,
  )
}

export function getProduct(idOrSku: string): Product {
  const product = findProduct(idOrSku)
  if (!product) throw notFoundError(`No product matches "${idOrSku}".`)
  return product
}

export function getProductDetail(idOrSku: string) {
  const store = getStore()
  const product = getProduct(idOrSku)
  return {
    ...product,
    available: availableUnits(product),
    belowReorderPoint: availableUnits(product) <= product.reorderPoint,
    adjustments: store.adjustments
      .filter((a) => a.productId === product.id)
      .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt)),
  }
}

export interface AdjustStockInput {
  productId: string
  /** Signed units: +12 for a delivery, -1 for damage. */
  delta: number
  reason: string
  createdBy: string
}

let adjustmentCounter = 0

/**
 * The inventory write. Corrects on-hand stock and records why — a stock level
 * that changed with no reason attached is exactly the thing nobody can audit
 * later.
 */
export function adjustStock(input: AdjustStockInput): { product: Product; adjustment: StockAdjustment } {
  const product = getProduct(input.productId)

  // Validate before mutating: a whole non-zero number of units.
  if (!Number.isInteger(input.delta) || input.delta === 0) {
    throw badRequestError("delta must be a non-zero whole number of units.")
  }
  const reason = input.reason?.trim()
  if (!reason) {
    throw badRequestError("A reason is required for every stock adjustment.")
  }
  const next = product.stockOnHand + input.delta
  if (next < 0) {
    throw badRequestError(
      `Adjustment would take ${product.sku} to ${next} units. On hand is ${product.stockOnHand}.`,
    )
  }

  product.stockOnHand = next

  const adjustment: StockAdjustment = {
    id: `adj_${Date.now().toString(36)}_${adjustmentCounter++}`,
    productId: product.id,
    delta: input.delta,
    reason,
    createdAt: new Date().toISOString(),
    createdBy: input.createdBy,
  }
  getStore().adjustments.unshift(adjustment)
  return { product, adjustment }
}
