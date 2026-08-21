import Link from "next/link"
import { notFound } from "next/navigation"
import { getOrderDetail } from "@/server/orders"
import { refundableCents } from "@/server/refunds"
import { DomainError } from "@/server/errors"
import { OrderActions } from "@/components/orders/order-actions"
import { Card, CardHeader, PageHeader, StatusPill, Td, Th } from "@/components/ui"
import { fullDate, money, titleCase } from "@/lib/format"

export const dynamic = "force-dynamic"

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  let order
  try {
    order = getOrderDetail(decodeURIComponent(id))
  } catch (err) {
    if (err instanceof DomainError && err.kind === "not_found") notFound()
    throw err
  }

  const refundable = refundableCents(order.id)
  const refunded = order.refunds
    .filter((r) => r.status !== "failed")
    .reduce((n, r) => n + r.amountCents, 0)

  return (
    <>
      <PageHeader
        title={order.number}
        subtitle={`Placed ${fullDate(order.placedAt)} · ${titleCase(order.channel)}`}
      />

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <StatusPill status={order.status} />
        <span className="nums text-sm text-muted">{order.paymentRef}</span>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title="Items" />
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <Th>Product</Th>
                  <Th>SKU</Th>
                  <Th className="text-right">Qty</Th>
                  <Th className="text-right">Unit</Th>
                  <Th className="text-right">Total</Th>
                </tr>
              </thead>
              <tbody>
                {order.lines.map((line) => (
                  <tr key={line.id} className="border-b border-border last:border-0">
                    <Td>
                      <Link href={`/inventory/${line.sku}`} className="hover:underline">
                        {line.title}
                      </Link>
                    </Td>
                    <Td className="nums text-muted">{line.sku}</Td>
                    <Td className="nums text-right">{line.quantity}</Td>
                    <Td className="nums text-right text-muted">{money(line.unitPriceCents)}</Td>
                    <Td className="nums text-right">{money(line.lineTotalCents)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>

            <dl className="space-y-1 border-t border-border px-4 py-3 text-sm">
              <Row label="Subtotal" value={money(order.subtotalCents)} />
              <Row label="Shipping" value={money(order.shippingCents)} />
              <Row label="Tax" value={money(order.taxCents)} />
              <Row label="Total" value={money(order.totalCents)} strong />
              {refunded > 0 && (
                <Row label="Refunded" value={`− ${money(refunded)}`} tone="neg" />
              )}
            </dl>
          </Card>

          <Card>
            <CardHeader title="Actions" />
            <div className="px-4 py-3.5">
              <OrderActions
                orderNumber={order.number}
                status={order.status}
                refundableCents={refundable}
              />
            </div>
          </Card>

          {order.refunds.length > 0 && (
            <Card>
              <CardHeader title="Refunds" />
              <ul className="divide-y divide-border">
                {order.refunds.map((refund) => (
                  <li key={refund.id} className="px-4 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="nums text-sm font-medium">{money(refund.amountCents)}</span>
                      <StatusPill status={refund.status} />
                    </div>
                    <p className="mt-0.5 text-xs text-muted">
                      {titleCase(refund.reason)} · {fullDate(refund.createdAt)} · {refund.createdBy}
                    </p>
                    {refund.note && <p className="mt-1 text-sm text-ink-soft">{refund.note}</p>}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Customer" />
            <div className="space-y-1 px-4 py-3.5 text-sm">
              {order.customer ? (
                <>
                  <Link
                    href={`/customers/${order.customer.id}`}
                    className="font-medium hover:underline"
                  >
                    {order.customer.name}
                  </Link>
                  <p className="text-muted">{order.customer.email}</p>
                  <p className="nums text-muted">
                    {order.customer.orderCount} orders ·{" "}
                    {money(order.customer.lifetimeValueCents)} lifetime
                  </p>
                </>
              ) : (
                <p className="text-muted">Unknown customer.</p>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="Shipping to" />
            <div className="px-4 py-3.5 text-sm text-ink-soft">
              {order.shippingAddress ? (
                <>
                  <p>{order.shippingAddress.line1}</p>
                  {order.shippingAddress.line2 && <p>{order.shippingAddress.line2}</p>}
                  <p>
                    {order.shippingAddress.city}, {order.shippingAddress.region}{" "}
                    <span className="nums">{order.shippingAddress.postalCode}</span>
                  </p>
                </>
              ) : (
                <p className="text-muted">No address on file.</p>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="Shipment" />
            {order.shipment ? (
              <div className="px-4 py-3.5 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <Link href={`/shipments/${order.shipment.id}`} className="font-medium hover:underline">
                    {order.shipment.carrier}
                  </Link>
                  <StatusPill status={order.shipment.status} />
                </div>
                <p className="nums mt-0.5 text-xs text-muted">{order.shipment.trackingNumber}</p>
              </div>
            ) : (
              <p className="px-4 py-3.5 text-sm text-muted">Nothing has shipped yet.</p>
            )}
          </Card>

          {order.notes && (
            <Card>
              <CardHeader title="Notes" />
              <p className="px-4 py-3.5 text-sm whitespace-pre-line text-ink-soft">{order.notes}</p>
            </Card>
          )}
        </div>
      </div>
    </>
  )
}

function Row({
  label,
  value,
  strong,
  tone,
}: {
  label: string
  value: string
  strong?: boolean
  tone?: "neg"
}) {
  return (
    <div className="flex justify-between">
      <dt className={strong ? "font-medium" : "text-muted"}>{label}</dt>
      <dd
        className={`nums ${strong ? "font-medium" : ""} ${tone === "neg" ? "text-neg" : ""}`}
      >
        {value}
      </dd>
    </div>
  )
}
