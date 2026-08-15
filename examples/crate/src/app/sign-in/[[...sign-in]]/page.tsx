import { SignIn } from "@clerk/nextjs"
import { clerkEnabled } from "@/server/clerk-config"

export const dynamic = "force-dynamic"

export default function SignInPage() {
  if (!clerkEnabled) {
    return (
      <div className="py-24 text-center">
        <h1 className="text-xl font-semibold tracking-tight">Sign-in is switched off</h1>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted">
          Crate runs as the seeded owner until Clerk is configured. Set
          <code className="mx-1 rounded bg-hover px-1 py-0.5 text-xs">NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY</code>
          and
          <code className="mx-1 rounded bg-hover px-1 py-0.5 text-xs">CLERK_SECRET_KEY</code>
          in <code className="rounded bg-hover px-1 py-0.5 text-xs">.env.local</code> to turn it on.
        </p>
      </div>
    )
  }

  return (
    <div className="flex justify-center py-16">
      <SignIn />
    </div>
  )
}
