import Link from "next/link"
import { listOrders } from "@/server/orders"
import { getStore } from "@/server/store"
import { Card, Empty, PageHeader, StatusPill, Td, Th } from "@/components/ui"
import { money, shortDate } from "@/lib/format"
import clsx from "clsx"

export const dynamic = "force-dynamic"

const FILTERS = [
  { label: "All", status: undefined },
  { label: "Paid", status: "paid" },
  { label: "Fulfilled", status: "fulfilled" },
  { label: "Shipped", status: "shipped" },
  { label: "Delivered", status: "delivered" },
  { label: "Refunded", status: "refunded" },
  { label: "Cancelled", status: "cancelled" },
]

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string }>
}) {
  const { status, q } = await searchParams
  const store = getStore()

  // An unknown ?status= in the URL is a bad link, not a crash — fall back to
  // everything rather than throwing a page-level error at someone.
  let orders
  try {
    orders = listOrders({ status, q, limit: 200 })
  } catch {
    orders = listOrders({ q, limit: 200 })
  }

  return (
    <>
      <PageHeader title="Orders" subtitle="Newest first." />

      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        {FILTERS.map((filter) => {
          const active = (filter.status ?? "") === (status ?? "")
          const href = filter.status ? `/orders?status=${filter.status}` : "/orders"
          return (
            <Link
              key={filter.label}
              href={href}
              className={clsx(
                "rounded-full border px-3 py-1 text-xs transition-colors",
                active
                  ? "border-accent bg-accent-bg font-medium text-accent"
                  : "border-border text-ink-soft hover:bg-hover",
              )}
            >
              {filter.label}
            </Link>
          )
        })}
      </div>

      <Card>
        {orders.length === 0 ? (
          <Empty>No orders match that filter.</Empty>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <Th>Order</Th>
                <Th>Customer</Th>
                <Th>Placed</Th>
                <Th>Items</Th>
                <Th>Status</Th>
                <Th className="text-right">Total</Th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => {
                const customer = store.customers.find((c) => c.id === order.customerId)
                const units = order.lines.reduce((n, l) => n + l.quantity, 0)
                return (
                  <tr key={order.id} className="border-b border-border last:border-0 hover:bg-hover">
                    <Td>
                      <Link href={`/orders/${order.number}`} className="font-medium hover:underline">
                        {order.number}
                      </Link>
                    </Td>
                    <Td className="text-ink-soft">{customer?.name ?? "—"}</Td>
                    <Td className="nums text-muted">{shortDate(order.placedAt)}</Td>
                    <Td className="nums text-muted">{units}</Td>
                    <Td><StatusPill status={order.status} /></Td>
                    <Td className="nums text-right">{money(order.totalCents)}</Td>
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
