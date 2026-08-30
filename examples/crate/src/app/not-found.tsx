import Link from "next/link"

export default function NotFound() {
  return (
    <div className="py-24 text-center">
      <h1 className="text-xl font-semibold tracking-tight">Not found</h1>
      <p className="mt-1 text-sm text-muted">
        That order, customer, product or shipment doesn&apos;t exist.
      </p>
      <Link href="/" className="mt-4 inline-block text-sm text-accent hover:underline">
        Back to overview
      </Link>
    </div>
  )
}
