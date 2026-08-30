import Link from "next/link"
import clsx from "clsx"
import { availableUnits, listProducts } from "@/server/inventory"
import { Card, Empty, PageHeader, Td, Th } from "@/components/ui"
import { money } from "@/lib/format"

export const dynamic = "force-dynamic"

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; low?: string }>
}) {
  const { q, low } = await searchParams
  const lowOnly = low === "1" || low === "true"
  const products = listProducts({ q, lowStock: lowOnly, limit: 200 })

  return (
    <>
      <PageHeader title="Inventory" subtitle="On hand, reserved, and what is actually sellable." />

      <div className="mb-4 flex gap-1.5">
        <Link
          href="/inventory"
          className={clsx(
            "rounded-full border px-3 py-1 text-xs transition-colors",
            lowOnly ? "border-border text-ink-soft hover:bg-hover" : "border-accent bg-accent-bg font-medium text-accent",
          )}
        >
          All products
        </Link>
        <Link
          href="/inventory?low=1"
          className={clsx(
            "rounded-full border px-3 py-1 text-xs transition-colors",
            lowOnly ? "border-accent bg-accent-bg font-medium text-accent" : "border-border text-ink-soft hover:bg-hover",
          )}
        >
          Needs reordering
        </Link>
      </div>

      <Card>
        {products.length === 0 ? (
          <Empty>Nothing matches.</Empty>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <Th>Product</Th>
                <Th>SKU</Th>
                <Th>Category</Th>
                <Th className="text-right">On hand</Th>
                <Th className="text-right">Reserved</Th>
                <Th className="text-right">Available</Th>
                <Th className="text-right">Price</Th>
              </tr>
            </thead>
            <tbody>
              {products.map((product) => {
                const available = availableUnits(product)
                const short = available <= product.reorderPoint
                return (
                  <tr key={product.id} className="border-b border-border last:border-0 hover:bg-hover">
                    <Td>
                      <Link href={`/inventory/${product.sku}`} className="font-medium hover:underline">
                        {product.title}
                      </Link>
                    </Td>
                    <Td className="nums text-muted">{product.sku}</Td>
                    <Td className="text-ink-soft">{product.category}</Td>
                    <Td className="nums text-right">{product.stockOnHand}</Td>
                    <Td className="nums text-right text-muted">{product.stockReserved}</Td>
                    <Td className={clsx("nums text-right", short && "font-medium text-neg")}>
                      {available}
                      {short && <span className="ml-1 text-xs">· reorder</span>}
                    </Td>
                    <Td className="nums text-right">{money(product.priceCents)}</Td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Card>
    </>
  )
}
