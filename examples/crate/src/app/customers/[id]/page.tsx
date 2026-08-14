import Link from "next/link"
import { notFound } from "next/navigation"
import { getCustomerDetail } from "@/server/customers"
import { DomainError } from "@/server/errors"
import { Card, CardHeader, Empty, PageHeader, StatusPill, Stat, Td, Th } from "@/components/ui"
import { money, shortDate } from "@/lib/format"

export const dynamic = "force-dynamic"

export default async function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  let customer
  try {
    customer = getCustomerDetail(decodeURIComponent(id))
  } catch (err) {
    if (err instanceof DomainError && err.kind === "not_found") notFound()
    throw err
  }

  const address = customer.addresses.find((a) => a.id === customer.defaultAddressId)
  const refunded = customer.refunds
    .filter((r) => r.status !== "failed")
    .reduce((n, r) => n + r.amountCents, 0)

  return (
    <>
      <PageHeader
        title={customer.name}
        subtitle={`${customer.email}${customer.phone ? ` · ${customer.phone}` : ""}`}
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Lifetime value" value={money(customer.lifetimeValueCents)} />
        <Stat label="Orders" value={String(customer.orderCount)} />
        <Stat label="Refunded" value={money(refunded)} hint={`${customer.refunds.length} refunds`} />
        <Stat label="Customer since" value={shortDate(customer.createdAt)} />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Order history" />
          {customer.orders.length === 0 ? (
            <Empty>No orders yet.</Empty>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <Th>Order</Th>
                  <Th>Placed</Th>
                  <Th>Status</Th>
                  <Th className="text-right">Total</Th>
                </tr>
              </thead>
              <tbody>
                {customer.orders.map((order) => (
                  <tr key={order.id} className="border-b border-border last:border-0 hover:bg-hover">
                    <Td>
                      <Link href={`/orders/${order.number}`} className="font-medium hover:underline">
                        {order.number}
                      </Link>
                    </Td>
                    <Td className="nums text-muted">{shortDate(order.placedAt)}</Td>
                    <Td><StatusPill status={order.status} /></Td>
                    <Td className="nums text-right">{money(order.totalCents)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Default address" />
            <div className="px-4 py-3.5 text-sm text-ink-soft">
              {address ? (
                <>
                  <p>{address.line1}</p>
                  {address.line2 && <p>{address.line2}</p>}
                  <p>
                    {address.city}, {address.region}{" "}
                    <span className="nums">{address.postalCode}</span>
                  </p>
                  <p className="text-muted">{address.country}</p>
                </>
              ) : (
                <p className="text-muted">No address on file.</p>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="Notes" />
            {customer.notes ? (
              <p className="px-4 py-3.5 text-sm whitespace-pre-line text-ink-soft">
                {customer.notes}
              </p>
            ) : (
              <p className="px-4 py-3.5 text-sm text-muted">
                Nothing recorded. Support notes land here.
              </p>
            )}
          </Card>
        </div>
      </div>
    </>
  )
}
