/**
 * Ask-once-remember policy layer for the Flowlet guardrail engine.
 *
 * After an `"approve"` decision has been issued once for a given
 * principal + tool + exact arguments combination, every subsequent
 * identical call is auto-allowed without prompting again.
 *
 * Security invariant: `"deny"` decisions are NEVER recorded.  Recording a
 * deny as a cached entry would risk turning it into an `"allow"` under a
 * future code path change.  Only `"approve"` is memoised; `"allow"` needs
 * no memoisation because it is already unconditional.
 */

import type { ApprovalDecision, ApprovalPolicy, PolicyContext } from "./types";

// ---------------------------------------------------------------------------
// DecisionStore
// ---------------------------------------------------------------------------

/**
 * Async key-value store for memoised approval decisions.
 *
 * The interface is async so that a future persistent (e.g. Redis, SQLite)
 * backend can be injected without changing call-sites.
 */
export interface DecisionStore {
  get(key: string): Promise<ApprovalDecision | undefined>;
  set(key: string, decision: ApprovalDecision): Promise<void>;
}

/**
 * Create an in-memory `DecisionStore` backed by a `Map`.
 * All operations resolve immediately (no I/O).
 */
export function createInMemoryDecisionStore(): DecisionStore {
  const map = new Map<string, ApprovalDecision>();
  return {
    get(key) {
      return Promise.resolve(map.get(key));
    },
    set(key, decision) {
      map.set(key, decision);
      return Promise.resolve();
    },
  };
}

// ---------------------------------------------------------------------------
// canonicalKey
// ---------------------------------------------------------------------------

/**
 * Produce a stable, collision-resistant cache key from a policy context and
 * a policy version string.
 *
 * Components joined with `"\x00"` (NUL), which cannot appear in valid JSON
 * or typical user/tool-name strings, to minimise accidental collisions.
 */
export function canonicalKey(ctx: PolicyContext, policyVersion: string): string {
  const serialisedInput = JSON.stringify(ctx.input);
  return [ctx.principal.userId, ctx.toolName, serialisedInput, policyVersion].join(
    "\x00",
  );
}

// ---------------------------------------------------------------------------
// rememberDecisions
// ---------------------------------------------------------------------------

/**
 * Wrap `inner` with an ask-once-remember layer.
 *
 * Behaviour:
 * - If the store already holds a value for this (principal, tool, args, version)
 *   combination, return `"allow"` immediately — the user already approved it.
 * - Otherwise delegate to `inner`.  If the inner decision is `"approve"`,
 *   record it in the store (so the NEXT identical call is suppressed) and
 *   return `"approve"`.
 * - `"deny"` and `"allow"` from `inner` are passed through without recording.
 */
export function rememberDecisions(
  inner: ApprovalPolicy,
  store: DecisionStore,
  policyVersion = "v1",
): ApprovalPolicy {
  return {
    async evaluate(ctx: PolicyContext): Promise<ApprovalDecision> {
      const key = canonicalKey(ctx, policyVersion);

      const remembered = await store.get(key);
      if (remembered !== undefined) {
        // A previous "approve" was already presented to the user — skip re-prompt.
        return "allow";
      }

      const decision = await inner.evaluate(ctx);

      if (decision === "approve") {
        await store.set(key, "approve");
      }

      return decision;
    },
  };
}
