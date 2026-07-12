import Link from "next/link"
import { Button } from "@/components/ui/button"
import { MapleMark } from "@/components/ui/maple-mark"

export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-[12px] bg-ink text-xl font-bold text-white">
        <MapleMark className="h-6 w-6 text-white" />
      </span>
      <h1 className="mt-6 text-3xl font-semibold tracking-tight text-ink">Page not found</h1>
      <p className="mt-2 max-w-sm text-sm text-muted">
        The page you&apos;re looking for doesn&apos;t exist or may have moved.
      </p>
      <Link href="/" className="mt-6">
        <Button>Back to home</Button>
      </Link>
    </div>
  )
}
