import Link from "next/link"
import clsx from "clsx"
import { listShipments } from "@/server/shipments"
import { getStore } from "@/server/store"
import { Card, Empty, PageHeader, StatusPill, Td, Th } from "@/components/ui"
import { shortDate } from "@/lib/format"

export const dynamic = "force-dynamic"

export default async function ShipmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ problems?: string }>
}) {
  const { problems } = await searchParams
  const problemsOnly = problems === "1" || problems === "true"
  const shipments = listShipments({ problemsOnly, limit: 200 })
  const store = getStore()

  return (
    <>
      <PageHeader title="Shipments" subtitle="Most recently shipped first." />

      <div className="mb-4 flex gap-1.5">
        <Link
          href="/shipments"
          className={clsx(
            "rounded-full border px-3 py-1 text-xs transition-colors",
            problemsOnly ? "border-border text-ink-soft hover:bg-hover" : "border-accent bg-accent-bg font-medium text-accent",
          )}
        >
          All
        </Link>
        <Link
          href="/shipments?problems=1"
          className={clsx(
            "rounded-full border px-3 py-1 text-xs transition-colors",
            problemsOnly ? "border-accent bg-accent-bg font-medium text-accent" : "border-border text-ink-soft hover:bg-hover",
          )}
        >
          Needs a human
        </Link>
      </div>

      <Card>
        {shipments.length === 0 ? (
          <Empty>Nothing to show.</Empty>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <Th>Order</Th>
                <Th>Carrier</Th>
                <Th>Tracking</Th>
                <Th>Shipped</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {shipments.map((shipment) => {
                const order = store.orders.find((o) => o.id === shipment.orderId)
                return (
                  <tr key={shipment.id} className="border-b border-border last:border-0 hover:bg-hover">
                    <Td>
                      <Link href={`/shipments/${shipment.id}`} className="font-medium hover:underline">
                        {order?.number ?? shipment.id}
                      </Link>
                    </Td>
                    <Td className="text-ink-soft">{shipment.carrier}</Td>
                    <Td className="nums text-muted">{shipment.trackingNumber}</Td>
                    <Td className="nums text-muted">
                      {shipment.shippedAt ? shortDate(shipment.shippedAt) : "—"}
                    </Td>
                    <Td><StatusPill status={shipment.status} /></Td>
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
