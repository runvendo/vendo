import { VendoError } from "@vendoai/core"
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
 * deployment being CONFIGURED without one, which surfaces two ways: the
 * unconfigured adapter refusing with `not-implemented` (no Cloud key), and
 * `validation` when no public URL is set for Cloud to deliver to. Both mean the
 * same thing to a person — texting is not available on this deployment.
 *
 * Everything else is an outage, not a setting: a store blip, a console that is
 * down, a vendor timeout. Answering `url: null` to those would tell the customer
 * their text channel is switched OFF, and the modal caches that because it does
 * not revalidate — so one transient failure would read as permanently disabled.
 * Those get a 503 the UI can retry.
 */
export async function GET(request: Request) {
  // mapleAuth resolves every visitor, signed in or not (the shared demo guest),
  // so null is unreachable here — the seam's type just allows it.
  const principal = await mapleAuth.principal(request)
  if (principal === null) return ok({ url: null })
  try {
    const { url } = await vendo.channels.text.link(principal)
    return ok({ url })
  } catch (error) {
    const unavailableByConfig = error instanceof VendoError
      && (error.code === "not-implemented" || error.code === "validation")
    if (unavailableByConfig) return ok({ url: null })
    console.error("[maple] text-link mint failed", {
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    })
    return serverError("Could not start texting just now.")
  }
}
