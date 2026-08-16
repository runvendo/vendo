import {
  VendoError,
  isReservedSubject,
  principalSchema,
  type RunContext,
} from "@vendoai/core";
import type { WireDeps } from "./shared.js";

/** The one shared per-request context resolution pass (kill-list B4): resolve
    the host's principal, enforce the resolver invariants, and assemble the
    RunContext. Every wire area resolves context through createContextResolver
    below. */

function requestHeaders(request: Request): Record<string, string> {
  return Object.fromEntries(request.headers.entries());
}

/** The one context-resolution pass every route shares (kill-list B4): resolve
    the host principal, enforce the resolver invariants, and assemble the
    RunContext. Returned resolver is called per route with a venue. */
export function createContextResolver(
  deps: WireDeps,
): (req: Request, venue: RunContext["venue"]) => Promise<RunContext> {
  return async (req, venue) => {
    let resolved: Awaited<ReturnType<WireDeps["principal"]>>;
    try {
      resolved = await deps.principal(req);
    } catch (error) {
      if (error instanceof VendoError) throw error;
      // #872 — the resolver's own message is actionable host-facing copy (the
      // presets write it to be shown); the catch-all's generic "Internal Vendo
      // error" cost a debugging session per config mistake.
      throw new VendoError(
        "not-implemented",
        `principal resolution failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const sessionId = req.headers.get("x-vendo-session-id") ?? deps.sessionId;
    // Vendo mints no principals: a resolver that answers null has told us this
    // visitor has no identity, and there is nothing to serve them AS. 403, not
    // 401 — the host owns sign-in, so only the host can say what to do next.
    if (resolved === null) {
      throw new VendoError(
        "forbidden",
        "no identity for this request: the `principal:` resolver returned null. "
        + "Return a principal for every visitor this deployment serves — e.g. "
        + "`principal: async () => ({ kind: \"user\", subject: \"dev\" })`. Vendo no longer mints anonymous sessions.",
      );
    }
    const parsed = principalSchema.safeParse(resolved);
    if (!parsed.success) {
      throw new VendoError("validation", "principal resolver returned an invalid principal");
    }
    // Block-actions design §C: host resolvers mint USER principals only —
    // org context is derived from membership, never resolved — and the
    // `vendo:` namespace is reserved for runtime-minted subjects (webhook
    // trigger principals, org subjects). Both rejections are LOUD: a
    // resolver colliding with the reserved namespace could otherwise act
    // as an org or a webhook principal.
    if (parsed.data.kind !== "user") {
      throw new VendoError("validation", "principal resolver must mint kind:\"user\" principals; org context is derived from org membership");
    }
    if (isReservedSubject(parsed.data.subject)) {
      throw new VendoError("validation", "principal resolver produced a reserved subject (the vendo: namespace is runtime-minted only)");
    }
    const principal = parsed.data;
    // Build contract §9.1 — asserted, never stored: ONE call to the host's own
    // org query per resolved context, stashed here so every door downstream of
    // it reads the same answer. An ephemeral visitor belongs to no org by
    // construction (the host issued them nothing), so the seam is not even
    // asked.
    const memberships = deps.memberships === undefined || principal.ephemeral === true
      ? undefined
      : await deps.memberships(principal);
    // Spec 2026-08-05 §1 — the host's asserted profile facts for THIS request's
    // user, refreshed per request (decision 2; the preset shares the session
    // decode with `principal`, so this costs no second verify).
    const user = deps.userFacts === undefined ? undefined : await deps.userFacts(req);
    // The shared meters this user's usage also counts into, refreshed per
    // request for the same reason and off the same decode.
    const pools = deps.userPools === undefined ? undefined : await deps.userPools(req);
    return {
      principal,
      venue,
      presence: "present",
      sessionId,
      requestHeaders: requestHeaders(req),
      ...(memberships === undefined ? {} : { memberships }),
      ...(user === undefined ? {} : { user }),
      ...(pools === undefined ? {} : { pools }),
    };
  };
}
