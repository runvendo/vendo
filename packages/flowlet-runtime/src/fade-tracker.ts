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

  function isEligible(state: PrincipalState, tool: string, key: string): boolean {
    if (state.suppressed.has(suppressionKey(tool, key))) return false;
    const inWindow = state.decisions.filter((d) => d.tool === tool && d.shapeKey === key);
    const yes = inWindow.filter((d) => d.decision === "yes").length;
    const no = inWindow.filter((d) => d.decision === "no").length;
    return yes >= threshold && no === 0;
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
      return { shape, proposalId: id };
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
  };
}
