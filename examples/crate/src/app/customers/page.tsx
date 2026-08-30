import Link from "next/link"
import { listCustomers } from "@/server/customers"
import { Card, Empty, PageHeader, Td, Th } from "@/components/ui"
import { money, shortDate } from "@/lib/format"

export const dynamic = "force-dynamic"

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>
}) {
  const { q } = await searchParams
  const customers = listCustomers({ q, limit: 200 })

  return (
    <>
      <PageHeader title="Customers" subtitle="Biggest spenders first." />

      <Card>
        {customers.length === 0 ? (
          <Empty>Nobody matches that search.</Empty>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <Th>Name</Th>
                <Th>Email</Th>
                <Th>Since</Th>
                <Th className="text-right">Orders</Th>
                <Th className="text-right">Lifetime</Th>
              </tr>
            </thead>
            <tbody>
              {customers.map((customer) => (
                <tr key={customer.id} className="border-b border-border last:border-0 hover:bg-hover">
                  <Td>
                    <Link href={`/customers/${customer.id}`} className="font-medium hover:underline">
                      {customer.name}
                    </Link>
                  </Td>
                  <Td className="text-ink-soft">{customer.email}</Td>
                  <Td className="nums text-muted">{shortDate(customer.createdAt)}</Td>
                  <Td className="nums text-right">{customer.orderCount}</Td>
                  <Td className="nums text-right">{money(customer.lifetimeValueCents)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  )
}
