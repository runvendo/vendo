import { notFound } from "next/navigation"
import { getProductDetail } from "@/server/inventory"
import { DomainError } from "@/server/errors"
import { AdjustStockForm } from "@/components/inventory/adjust-stock-form"
import { Card, CardHeader, Empty, PageHeader, Stat } from "@/components/ui"
import { fullDate, money } from "@/lib/format"

export const dynamic = "force-dynamic"

export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  let product
  try {
    product = getProductDetail(decodeURIComponent(id))
  } catch (err) {
    if (err instanceof DomainError && err.kind === "not_found") notFound()
    throw err
  }

  return (
    <>
      <PageHeader title={product.title} subtitle={`${product.sku} · ${product.category}`} />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Price" value={money(product.priceCents)} />
        <Stat label="On hand" value={String(product.stockOnHand)} />
        <Stat label="Reserved" value={String(product.stockReserved)} hint="unshipped orders" />
        <Stat
          label="Available"
          value={String(product.available)}
          hint={product.belowReorderPoint ? `below reorder point of ${product.reorderPoint}` : `reorder at ${product.reorderPoint}`}
        />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Stock history" />
          {product.adjustments.length === 0 ? (
            <Empty>No adjustments recorded.</Empty>
          ) : (
            <ul className="divide-y divide-border">
              {product.adjustments.map((adjustment) => (
                <li key={adjustment.id} className="flex items-baseline justify-between gap-4 px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-sm text-ink-soft">{adjustment.reason}</p>
                    <p className="mt-0.5 text-xs text-muted">
                      {fullDate(adjustment.createdAt)} · {adjustment.createdBy}
                    </p>
                  </div>
                  <span
                    className={`nums shrink-0 text-sm font-medium ${adjustment.delta > 0 ? "text-pos" : "text-neg"}`}
                  >
                    {adjustment.delta > 0 ? "+" : ""}
                    {adjustment.delta}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Adjust stock" />
            <AdjustStockForm sku={product.sku} />
          </Card>

          <Card>
            <CardHeader title="Description" />
            <p className="px-4 py-3.5 text-sm text-ink-soft">{product.description}</p>
          </Card>
        </div>
      </div>
    </>
  )
}
