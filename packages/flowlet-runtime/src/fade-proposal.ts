/**
 * `handleFadeProposal` — resolves a fade proposal's accept/decline (ENG-193
 * §4.4). Mirrors `handleConsent`'s shape (transport-agnostic, audits every
 * decision) but is keyed by `proposalId`, not toolCallId/thread — a fade
 * proposal has neither (same reasoning as `ParkedActionResolution`).
 *
 * NEVER TRUSTS THE CLIENT: `accept: true` re-derives (tool, shape) from the
 * FadeTracker's OWN memory of what it offered and re-verifies eligibility is
 * STILL live right now — a forged accept for a stale, unknown, or
 * no-longer-eligible proposalId mints nothing. A second, redundant check
 * against the tool's LIVE descriptor tier (critical/unverified) guards
 * against the offer itself having been mis-gated — the same defense-in-depth
 * `grantManager.create` already applies at its own boundary.
 *
 * ONE-SHOT ACCEPT (review follow-up): a successful mint immediately consumes
 * the tracker's offer, so a double-click/network retry of the same
 * proposalId — or a replay after the minted grant is later revoked — finds
 * no offer and fails closed instead of silently minting a duplicate grant.
 */
import type { AuditLog, FadeProposalResolution, GrantStore, Principal } from "@flowlet/core";
import type { ToolDescriptor } from "./descriptor";
import type { FadeTracker } from "./fade-tracker";
import { grantScopeFromShape } from "./policy/fade-shapes";
import { createGrantManager } from "./grant-manager";
import { dangerTier, isUnverified } from "./policy/tier";

export interface HandleFadeProposalDeps {
  fadeTracker: FadeTracker;
  grants: GrantStore;
  audit: AuditLog;
  resolveDescriptor: (toolName: string) => ToolDescriptor | undefined;
  now?: () => string;
}

export type HandleFadeProposalResult =
  | { ok: true }
  | { ok: false; status: 400 | 403 | 404; error: string };

export async function handleFadeProposal(
  deps: HandleFadeProposalDeps,
  principal: Principal,
  req: FadeProposalResolution,
): Promise<HandleFadeProposalResult> {
  const clock = deps.now ?? (() => new Date().toISOString());
  async function audited(result: HandleFadeProposalResult): Promise<HandleFadeProposalResult> {
    await deps.audit.append({
      at: clock(), principal, kind: "consent",
      consentId: req.proposalId, decision: req.accept ? "yes" : "no",
    });
    return result;
  }

  if (!req.accept) {
    const declined = deps.fadeTracker.decline(principal, req.proposalId);
    if (!declined) {
      return audited({ ok: false, status: 404, error: `unknown fade proposal "${req.proposalId}"` });
    }
    return audited({ ok: true });
  }

  const resolved = deps.fadeTracker.resolveEligible(principal, req.proposalId);
  if (!resolved) {
    return audited({
      ok: false, status: 403,
      error: `fade proposal "${req.proposalId}" is unknown or no longer eligible`,
    });
  }

  // Finding 4 (concurrent double-accept race): claim the offer SYNCHRONOUSLY
  // right here — before any `await` — so a second concurrent accept for the
  // SAME proposalId can never also pass `resolveEligible` above: single-
  // process in-memory state plus JS's run-to-completion semantics mean this
  // claim is atomic against a racing call (each call's synchronous prefix
  // runs to its first `await` before the other's runs at all). Every failure
  // path below RESTORES the offer (one-shot accept is preserved: only a
  // create that actually succeeds keeps it consumed), so a corrected retry —
  // or the SAME transient failure retried — still finds the offer.
  const claimed = deps.fadeTracker.consume(principal, req.proposalId);
  if (!claimed) {
    // Unreachable in practice — `resolveEligible` just confirmed the offer
    // exists and nothing async has run since — but fail closed rather than
    // crash if it ever isn't.
    return audited({
      ok: false, status: 403,
      error: `fade proposal "${req.proposalId}" is unknown or no longer eligible`,
    });
  }

  const descriptor = deps.resolveDescriptor(resolved.tool);
  if (!descriptor) {
    deps.fadeTracker.restore(principal, req.proposalId, claimed);
    return audited({ ok: false, status: 404, error: `unknown tool "${resolved.tool}"` });
  }
  if (dangerTier(descriptor) === "critical" || isUnverified(descriptor)) {
    deps.fadeTracker.restore(principal, req.proposalId, claimed);
    return audited({
      ok: false, status: 403,
      error: `refusing fade grant for "${resolved.tool}" — critical/unverified tools are never fadeable`,
    });
  }
  const manager = createGrantManager({ store: deps.grants, audit: deps.audit, now: clock });
  try {
    await manager.create(
      principal,
      {
        tool: resolved.tool,
        scope: grantScopeFromShape(resolved.shape),
        duration: "standing",
        source: { kind: "fade" },
      },
      descriptor,
    );
  } catch (err) {
    deps.fadeTracker.restore(principal, req.proposalId, claimed);
    const message = err instanceof Error ? err.message : String(err);
    return audited({ ok: false, status: 403, error: message });
  }
  return audited({ ok: true });
}
