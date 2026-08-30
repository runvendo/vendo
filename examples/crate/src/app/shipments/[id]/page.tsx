import Link from "next/link"
import { notFound } from "next/navigation"
import { getShipmentDetail } from "@/server/shipments"
import { DomainError } from "@/server/errors"
import { Card, CardHeader, PageHeader, StatusPill } from "@/components/ui"
import { fullDate, titleCase } from "@/lib/format"

export const dynamic = "force-dynamic"

export default async function ShipmentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  let shipment
  try {
    shipment = getShipmentDetail(decodeURIComponent(id))
  } catch (err) {
    if (err instanceof DomainError && err.kind === "not_found") notFound()
    throw err
  }

  return (
    <>
      <PageHeader
        title={shipment.order?.number ?? shipment.id}
        subtitle={`${shipment.carrier} · ${shipment.trackingNumber}`}
      />

      <div className="mb-5">
        <StatusPill status={shipment.status} />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Timeline" />
          <ol className="divide-y divide-border">
            {[...shipment.events].reverse().map((event, index) => (
              <li key={`${event.at}-${index}`} className="px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-medium">{titleCase(event.status)}</span>
                  <span className="nums text-xs text-muted">{fullDate(event.at)}</span>
                </div>
                {(event.location || event.detail) && (
                  <p className="mt-0.5 text-xs text-muted">
                    {[event.location, event.detail].filter(Boolean).join(" · ")}
                  </p>
                )}
              </li>
            ))}
          </ol>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Order" />
            <div className="px-4 py-3.5 text-sm">
              {shipment.order ? (
                <Link href={`/orders/${shipment.order.number}`} className="font-medium hover:underline">
                  {shipment.order.number}
                </Link>
              ) : (
                <p className="text-muted">Order missing.</p>
              )}
              {shipment.customer && (
                <p className="mt-0.5 text-muted">{shipment.customer.name}</p>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="Dates" />
            <dl className="space-y-1 px-4 py-3.5 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted">Shipped</dt>
                <dd className="nums">{shipment.shippedAt ? fullDate(shipment.shippedAt) : "—"}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">Estimated</dt>
                <dd className="nums">
                  {shipment.estimatedDelivery ? fullDate(shipment.estimatedDelivery) : "—"}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">Delivered</dt>
                <dd className="nums">
                  {shipment.deliveredAt ? fullDate(shipment.deliveredAt) : "—"}
                </dd>
              </div>
            </dl>
          </Card>
        </div>
      </div>
    </>
  )
}
