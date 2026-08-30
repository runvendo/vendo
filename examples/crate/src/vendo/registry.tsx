import { z } from "zod"
import { Card, CardHeader, StatusPill, Td, Th } from "@/components/ui"
import { money, shortDate } from "@/lib/format"

// Crate's host component registry: the components the agent renders INSIDE
// Crate's own surface, so generated UI looks like the app instead of generic
// chrome. Defined once and read twice — `createVendo({ catalog })` reads only
// the data fields (description/props/examples) to brief the model, and
// `<VendoProvider components>` reads only the component references to render.
//
// Deliberately NOT annotated `satisfies ComponentRegistry`: that type lives in
// `@vendoai/apps/contract`, and a host that only depends on `@vendoai/vendo`
// would have to add a whole package as a dependency to borrow one type. Both
// consumers accept this shape structurally, so a mistake here is still a type
// error at the two use sites — where it actually matters.
//
// Every component renders null until its props bind. Mid-stream the model can
// mount a component before the tool result arrives, and a card that throws
// takes the whole turn's UI with it.

function CrateOrderCard({
  number,
  status,
  placedAt,
  totalCents,
  customerName,
}: {
  number?: string
  status?: string
  placedAt?: string
  totalCents?: number
  customerName?: string
}) {
  if (!number || !status) return null
  return (
    <Card className="my-2">
      <CardHeader title={number} action={<StatusPill status={status} />} />
      <div className="px-4 py-3 text-sm">
        {customerName && <p className="font-medium">{customerName}</p>}
        <div className="mt-1 flex items-baseline justify-between text-muted">
          {placedAt && <span className="text-xs">{shortDate(placedAt)}</span>}
          {typeof totalCents === "number" && (
            <span className="nums text-base font-semibold text-ink">{money(totalCents)}</span>
          )}
        </div>
      </div>
    </Card>
  )
}

function CrateLineItems({
  lines,
  totalCents,
}: {
  lines?: Array<{ sku: string; title: string; quantity: number; lineTotalCents: number }>
  totalCents?: number
}) {
  if (!lines?.length) return null
  return (
    <Card className="my-2 overflow-hidden">
      <table className="w-full">
        <thead>
          <tr className="border-b border-border">
            <Th>Item</Th>
            <Th className="text-right">Qty</Th>
            <Th className="text-right">Total</Th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.sku} className="border-b border-border last:border-0">
              <Td>
                <span className="font-medium">{line.title}</span>
                <span className="ml-2 text-xs text-muted">{line.sku}</span>
              </Td>
              <Td className="nums text-right">{line.quantity}</Td>
              <Td className="nums text-right">{money(line.lineTotalCents)}</Td>
            </tr>
          ))}
        </tbody>
        {typeof totalCents === "number" && (
          <tfoot>
            <tr>
              <Td className="font-medium">Total</Td>
              <Td />
              <Td className="nums text-right font-semibold">{money(totalCents)}</Td>
            </tr>
          </tfoot>
        )}
      </table>
    </Card>
  )
}

function CrateCustomerSummary({
  name,
  email,
  lifetimeValueCents,
  orderCount,
}: {
  name?: string
  email?: string
  lifetimeValueCents?: number
  orderCount?: number
}) {
  if (!name) return null
  return (
    <Card className="my-2 px-4 py-3.5">
      <p className="text-sm font-semibold">{name}</p>
      {email && <p className="text-xs text-muted">{email}</p>}
      <div className="mt-3 flex gap-6">
        {typeof lifetimeValueCents === "number" && (
          <div>
            <p className="text-xs text-muted">Lifetime value</p>
            <p className="nums text-lg font-semibold tracking-tight">{money(lifetimeValueCents)}</p>
          </div>
        )}
        {typeof orderCount === "number" && (
          <div>
            <p className="text-xs text-muted">Orders</p>
            <p className="nums text-lg font-semibold tracking-tight">{orderCount}</p>
          </div>
        )}
      </div>
    </Card>
  )
}

export const crateRegistry = {
  CrateOrderCard: {
    component: CrateOrderCard,
    description:
      "The default Crate card for a SINGLE order: its number, status, date, customer and total. Use it whenever the answer is about one specific order — looking one up, confirming a fulfil/cancel/refund landed, or naming the order a question is about. Bind it to one order object from host_getOrder or one element of host_listOrders' `orders` array, never to the response body itself. `totalCents` is integer cents.",
    props: z.object({
      number: z.string().describe('The human-facing order number, e.g. "CR-1084"'),
      status: z.enum([
        "pending", "paid", "fulfilled", "shipped", "delivered", "cancelled", "refunded",
      ]),
      placedAt: z.string().optional().describe("ISO 8601 timestamp"),
      totalCents: z.number().optional().describe("Order total in integer cents"),
      customerName: z.string().optional(),
    }),
    examples: [
      '{"number":"CR-1084","status":"delivered","placedAt":"2026-07-28T15:42:00.000Z","totalCents":129900,"customerName":"Dana Whitfield"}',
    ],
  },
  CrateLineItems: {
    component: CrateLineItems,
    description:
      "The Crate line-item table: what was actually in an order, per SKU, with quantities and line totals. Use it when the request is about an order's CONTENTS rather than its status — what was ordered, how many, what each line cost. `lines` takes the ARRAY of line rows: bind it to an order's `lines` array (host_getOrder({...}).lines), never to the order object itself, which renders an empty table. All money is integer cents.",
    props: z.object({
      lines: z.array(
        z.object({
          sku: z.string(),
          title: z.string(),
          quantity: z.number(),
          lineTotalCents: z.number().describe("Line total in integer cents"),
        }),
      ),
      totalCents: z.number().optional().describe("Order total in integer cents"),
    }),
    examples: [
      '{"lines":[{"sku":"CRT-ESP-01","title":"Lumen Espresso Machine","quantity":1,"lineTotalCents":129900}],"totalCents":129900}',
    ],
  },
  CrateCustomerSummary: {
    component: CrateCustomerSummary,
    description:
      "The Crate customer card: who they are plus lifetime value and order count. Use it when the request is about a PERSON rather than an order — looking a customer up, or giving context before acting on their behalf. Bind it to one customer object from host_getCustomer. `lifetimeValueCents` is integer cents, and a full refund removes that order from it.",
    props: z.object({
      name: z.string(),
      email: z.string().optional(),
      lifetimeValueCents: z.number().optional().describe("Lifetime value in integer cents"),
      orderCount: z.number().optional(),
    }),
    examples: [
      '{"name":"Dana Whitfield","email":"dana.whitfield@example.com","lifetimeValueCents":284700,"orderCount":6}',
    ],
  },
}
