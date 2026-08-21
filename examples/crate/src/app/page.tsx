import Link from "next/link"
import { dashboardSummary, needsAttention } from "@/server/metrics"
import { getStore } from "@/server/store"
import { availableUnits } from "@/server/inventory"
import { Card, CardHeader, Empty, PageHeader, Stat, StatusPill, Td, Th } from "@/components/ui"
import { money, shortDate } from "@/lib/format"

// The store lives in memory and changes as soon as anyone refunds anything, so
// nothing here may be cached at build time.
export const dynamic = "force-dynamic"

export default function OverviewPage() {
  const summary = dashboardSummary()
  const { unfulfilledOrders, problemShipments, lowStock } = needsAttention()
  const store = getStore()

  const customerFor = (id: string) => store.customers.find((c) => c.id === id)
  const orderFor = (id: string) => store.orders.find((o) => o.id === id)

  return (
    <>
      <PageHeader title="Overview" subtitle="Where the shop stands this week." />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat
          label="Revenue, last 7 days"
          value={money(summary.revenueLast7DaysCents)}
          hint={`${summary.ordersLast7Days} orders`}
        />
        <Stat
          label="Awaiting fulfilment"
          value={String(summary.awaitingFulfilment)}
          hint="paid, not yet packed"
        />
        <Stat
          label="Shipment problems"
          value={String(summary.problemShipments)}
          hint="exceptions and returns"
        />
        <Stat
          label="Refunded, last 7 days"
          value={money(summary.refundedLast7DaysCents)}
          hint={`${summary.lowStockProducts} products low`}
        />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Oldest unfulfilled orders"
            action={
              <Link href="/orders?status=paid" className="text-xs text-accent hover:underline">
                All orders
              </Link>
            }
          />
          {unfulfilledOrders.length === 0 ? (
            <Empty>Nothing waiting. Every paid order has been packed.</Empty>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <Th>Order</Th>
                  <Th>Customer</Th>
                  <Th>Placed</Th>
                  <Th className="text-right">Total</Th>
                </tr>
              </thead>
              <tbody>
                {unfulfilledOrders.map((order) => (
                  <tr key={order.id} className="border-b border-border last:border-0 hover:bg-hover">
                    <Td>
                      <Link href={`/orders/${order.number}`} className="font-medium hover:underline">
                        {order.number}
                      </Link>
                    </Td>
                    <Td className="text-ink-soft">{customerFor(order.customerId)?.name ?? "—"}</Td>
                    <Td className="nums text-muted">{shortDate(order.placedAt)}</Td>
                    <Td className="nums text-right">{money(order.totalCents)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Needs a human" />
            {problemShipments.length === 0 ? (
              <Empty>No shipment problems.</Empty>
            ) : (
              <ul className="divide-y divide-border">
                {problemShipments.map((shipment) => {
                  const order = orderFor(shipment.orderId)
                  return (
                    <li key={shipment.id} className="px-4 py-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <Link
                          href={`/shipments/${shipment.id}`}
                          className="text-sm font-medium hover:underline"
                        >
                          {order?.number ?? shipment.id}
                        </Link>
                        <StatusPill status={shipment.status} />
                      </div>
                      <p className="mt-0.5 text-xs text-muted">
                        {shipment.carrier} · {shipment.trackingNumber}
                      </p>
                    </li>
                  )
                })}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader
              title="Low stock"
              action={
                <Link href="/inventory?low=1" className="text-xs text-accent hover:underline">
                  Inventory
                </Link>
              }
            />
            {lowStock.length === 0 ? (
              <Empty>Everything is above its reorder point.</Empty>
            ) : (
              <ul className="divide-y divide-border">
                {lowStock.map((product) => (
                  <li key={product.id} className="flex items-baseline justify-between px-4 py-2.5">
                    <Link
                      href={`/inventory/${product.sku}`}
                      className="truncate text-sm hover:underline"
                    >
                      {product.title}
                    </Link>
                    <span className="nums ml-3 shrink-0 text-sm text-neg">
                      {availableUnits(product)} left
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  )
}
