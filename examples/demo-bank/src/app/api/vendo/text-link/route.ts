import { ok, serverError } from "@/server/http"
import { mapleAuth, vendo } from "@/vendo/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * THIS USER'S TEXT-CHANNEL INVITE, minted on demand.
 *
 * The same call the wire's `/api/vendo/channels/text/link` anchor makes, but
 * answering JSON so the settings modal can render the `sms:` link and its QR in
 * Maple's own chrome instead of the door's fallback page.
 *
 * Called when the modal OPENS, never on page load: every mint replaces this
 * user's outstanding code (ChannelLinkRepository.mint), so a page-load mint
 * would invalidate the code of anyone who is mid-link on their phone.
 *
 * UNDER /api/vendo deliberately, beside the door's catch-all (Next prefers this
 * static segment over `[...vendo]`). That prefix is where the extractor stops
 * looking, so this stays a surface for Maple's own UI instead of joining the
 * agent's host tools — and it is one of proxy.ts's public prefixes, so the demo's
 * signed-out visitor reaches it exactly as they reach the anchor route.
 *
 * `url: null` is the graceful "this deployment has no text channel" answer —
 * the flag needs a Vendo Cloud key, and a demo without one must say so rather
 * than hand out a link that cannot work. It is reserved for EXACTLY that: the
 * deployment being configured without one — and that is answered from the
 * CONFIGURATION, not from the shape of an error. The two env vars this channel
 * needs are the same two `createVendo` composes it from: the Cloud key that
 * carries the numbers, and the public URL Cloud delivers back to.
 *
 * Reading it off error codes was the wrong instinct and I had it: `validation`
 * covers both "no VENDO_BASE_URL set" (a setting) and "Cloud returned no
 * identity to text" (an outage), so no code-based rule can separate them. With
 * the check up front, every error from `link()` is unambiguously an outage.
 *
 * That matters because `url: null` is sticky in the UI: it means "texting is not
 * available here", and a passing failure reported that way would read as
 * permanently switched off. Outages get a 503 the modal offers to retry.
 */
export async function GET(request: Request) {
  // mapleAuth resolves every visitor, signed in or not (the shared demo guest),
  // so null is unreachable here — the seam's type just allows it.
  const principal = await mapleAuth.principal(request)
  if (principal === null) return ok({ url: null })
  // No key or no public URL means this checkout of the demo has no text channel
  // at all — the honest, permanent answer, and the one the modal explains.
  if (!process.env.VENDO_API_KEY || !process.env.VENDO_BASE_URL) return ok({ url: null })
  try {
    const { url } = await vendo.channels.text.link(principal)
    return ok({ url })
  } catch (error) {
    console.error("[maple] text-link mint failed", {
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    })
    return serverError("Could not start texting just now.")
  }
}
