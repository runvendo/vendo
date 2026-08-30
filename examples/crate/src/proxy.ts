import { NextResponse, type NextRequest } from "next/server"
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server"
import { clerkPreset } from "@vendoai/actions/presets"
import { clerkEnabled } from "@/server/clerk-config"

/**
 * Next 16 calls this file `proxy.ts`; it is what older versions called
 * `middleware.ts`, and Next warns on the old name.
 *
 * Two jobs, in order.
 *
 * 1. VERIFY AWAY TOKENS. Clerk holds the private keys for its own sessions, so
 *    an unattended run cannot mint one — the preset mints a host-owned
 *    `VendoAway` token instead, and verifying it is the host's half of that
 *    split. The verifier strips any caller-supplied `x-vendo-away-*` headers
 *    before it looks at anything, then re-sets them from the token's verified
 *    claims, which is what makes them trustworthy downstream.
 *
 * 2. REQUIRE A SIGNED-IN HUMAN for everything else. The sign-in page and the
 *    Vendo wire are exempt: the wire does its own identity work with the same
 *    Clerk session, and bouncing it here would turn a clean "you are not staff"
 *    into an HTML redirect the agent cannot read.
 */
const isPublic = createRouteMatcher(["/sign-in(.*)", "/api/vendo(.*)"])

const awayVerifier = clerkPreset({})

const withClerk = clerkMiddleware(async (auth, request) => {
  if (!isPublic(request)) await auth.protect()
})

export default async function proxy(
  request: NextRequest,
  event: Parameters<typeof withClerk>[1],
) {
  const authorization = request.headers.get("authorization")
  if (authorization && /^VendoAway(?:\s|$)/i.test(authorization)) {
    // An away run identifies itself with the token alone. It never carries a
    // Clerk session, so it must not be sent through auth.protect() — the
    // verified subject in the headers is the whole identity.
    return awayVerifier.nextMiddleware(request)
  }

  // Unconfigured Clerk means an open shop rather than a broken one — a fresh
  // clone has no keys and must still run. See src/server/clerk-config.ts.
  if (!clerkEnabled) return NextResponse.next()
  return withClerk(request, event)
}

export const config = {
  matcher: [
    // Everything except Next's internals and static files, plus all API routes.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
}
