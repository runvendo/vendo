/**
 * FadeTracker (ENG-193 spec §4.4) — server-side, per-principal memory of
 * human yes/no decisions on act-tier calls, driving the fade proposal.
 * Injectable in-memory state (the `BreakerState`/`GrantStore` pattern) — a
 * cloud deployment swaps this for persistence behind the same shape.
 *
 * ELIGIBILITY: within the principal's last `windowSize` (default 20)
 * decisions of ANY tool/shape, >= `threshold` (default 3) "yes" of the SAME
 * shape and ZERO "no" of that shape. A declined proposal suppresses
 * re-proposing that exact shape (stored, not time-limited).
 *
 * TRUST BOUNDARY: `resolveEligible` looks up what THIS tracker itself
 * offered (never a client-supplied shape) and RE-CHECKS eligibility live —
 * a "no" or a decline landing between the offer and an accept must sour the
 * accept, never silently mint a grant anyway.
 *
 * ONE-SHOT ACCEPT (review follow-up): `resolveEligible` is a pure read, so
 * the caller MUST call `consume` once its accept actually mints a grant —
 * otherwise a double-click/network retry replays the same proposalId into a
 * second grant, and a revoke-then-replay silently re-grants. `consume` only
 * deletes the ONE offer; it never suppresses the shape (unlike `decline`),
 * so a later approval pattern can still earn a fresh proposal.
 */
import type { FadeShape } from "@flowlet/core";
import { deriveFadeShape, shapeKey, computeProposalId } from "./policy/fade-shapes";

export interface FadeTrackerOptions {
  /** "Yes" count required (same shape, zero "no") before offering. Default 3. */
  threshold?: number;
  /** Rolling per-principal decision window. Default 20. */
  windowSize?: number;
}

export interface FadeEligibility {
  shape: FadeShape;
  proposalId: string;
  /** The in-window "yes" count for this shape at proposal time (review
   *  follow-up) — carried through to the client so the fade card can render
   *  an accurate ordinal instead of a hardcoded "third". */
  count: number;
}

interface Decision {
  tool: string;
  shapeKey: string;
  decision: "yes" | "no";
}

interface PrincipalState {
  /** Rolling window, oldest first, capped at windowSize. */
  decisions: Decision[];
  /** `${tool}::${shapeKey}` -> declined forever (until explicitly cleared). */
  suppressed: Set<string>;
}

interface OfferedProposal {
  principalKey: string;
  tool: string;
  shape: FadeShape;
}

export interface FadeTracker {
  record(principal: { tenantId: string; subject: string }, tool: string, input: unknown, decision: "yes" | "no"): void;
  propose(principal: { tenantId: string; subject: string }, tool: string, input: unknown): FadeEligibility | null;
  resolveEligible(
    principal: { tenantId: string; subject: string },
    proposalId: string,
  ): { tool: string; shape: FadeShape } | undefined;
  decline(
    principal: { tenantId: string; subject: string },
    proposalId: string,
  ): { tool: string; shape: FadeShape } | undefined;
  /** Consume a successfully-accepted offer (review follow-up) — accept is
   *  one-shot. Idempotent-safe: replaying an already-consumed or unknown id
   *  is a no-op, never a throw. Does NOT suppress the shape (see `decline`
   *  for that) — only this one offer is removed. Returns the removed offer
   *  (or `undefined` if there was nothing to remove) so a caller can
   *  {@link restore} it if what happens next fails. */
  consume(
    principal: { tenantId: string; subject: string },
    proposalId: string,
  ): { tool: string; shape: FadeShape } | undefined;
  /** Rollback for `consume` (ENG-193 review follow-up — finding 4): a
   *  successful `consume` claims the offer SYNCHRONOUSLY, before the async
   *  grant-mint work that follows — if that work then fails (a validation
   *  400/403/404, or the grant store itself throwing), the offer must be put
   *  BACK so a corrected retry can still succeed instead of losing the
   *  eligibility window forever. A no-op if another offer already exists
   *  under this id (never clobbers). */
  restore(
    principal: { tenantId: string; subject: string },
    proposalId: string,
    offer: { tool: string; shape: FadeShape },
  ): void;
}

function principalKey(p: { tenantId: string; subject: string }): string {
  return `${p.tenantId}::${p.subject}`;
}
function suppressionKey(tool: string, key: string): string {
  return `${tool}::${key}`;
}

export function createFadeTracker(opts: FadeTrackerOptions = {}): FadeTracker {
  const threshold = opts.threshold ?? 3;
  const windowSize = opts.windowSize ?? 20;
  const principals = new Map<string, PrincipalState>();
  const offered = new Map<string, OfferedProposal>();

  function stateFor(p: { tenantId: string; subject: string }): PrincipalState {
    const key = principalKey(p);
    let state = principals.get(key);
    if (!state) {
      state = { decisions: [], suppressed: new Set() };
      principals.set(key, state);
    }
    return state;
  }

  function yesCount(state: PrincipalState, tool: string, key: string): number {
    return state.decisions.filter((d) => d.tool === tool && d.shapeKey === key && d.decision === "yes").length;
  }

  function isEligible(state: PrincipalState, tool: string, key: string): boolean {
    if (state.suppressed.has(suppressionKey(tool, key))) return false;
    const inWindow = state.decisions.filter((d) => d.tool === tool && d.shapeKey === key);
    const no = inWindow.filter((d) => d.decision === "no").length;
    return yesCount(state, tool, key) >= threshold && no === 0;
  }

  return {
    record(principal, tool, input, decision) {
      const state = stateFor(principal);
      const shape = deriveFadeShape(input);
      state.decisions.push({ tool, shapeKey: shapeKey(shape), decision });
      if (state.decisions.length > windowSize) state.decisions.shift();
    },

    propose(principal, tool, input) {
      const state = stateFor(principal);
      const shape = deriveFadeShape(input);
      const key = shapeKey(shape);
      if (!isEligible(state, tool, key)) return null;
      const id = computeProposalId(principal, tool, shape);
      offered.set(id, { principalKey: principalKey(principal), tool, shape });
      return { shape, proposalId: id, count: yesCount(state, tool, key) };
    },

    resolveEligible(principal, proposalId) {
      const offer = offered.get(proposalId);
      if (!offer || offer.principalKey !== principalKey(principal)) return undefined;
      const state = stateFor(principal);
      if (!isEligible(state, offer.tool, shapeKey(offer.shape))) return undefined;
      return { tool: offer.tool, shape: offer.shape };
    },

    decline(principal, proposalId) {
      const offer = offered.get(proposalId);
      if (!offer || offer.principalKey !== principalKey(principal)) return undefined;
      const state = stateFor(principal);
      state.suppressed.add(suppressionKey(offer.tool, shapeKey(offer.shape)));
      return { tool: offer.tool, shape: offer.shape };
    },

    consume(principal, proposalId) {
      const offer = offered.get(proposalId);
      if (!offer || offer.principalKey !== principalKey(principal)) return undefined;
      offered.delete(proposalId);
      return { tool: offer.tool, shape: offer.shape };
    },

    restore(principal, proposalId, offer) {
      if (offered.has(proposalId)) return; // never clobber a newer offer under this id
      offered.set(proposalId, { principalKey: principalKey(principal), tool: offer.tool, shape: offer.shape });
    },
  };
}
