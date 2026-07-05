/**
 * Ask-once-remember policy layer for the Vendo guardrail engine.
 *
 * After a call has been APPROVED AND ACTUALLY EXECUTED once for a given
 * principal + tool + exact arguments combination, every subsequent identical
 * call is auto-allowed without prompting again.
 *
 * Security invariants (fail-closed):
 * - Recording happens ONLY in `onExecuted`, which `wrapTool` calls after the
 *   real tool successfully runs. Nothing is recorded at ask/`evaluate` time, so
 *   a call the user DENIES (execute skipped → `onExecuted` never fires) is never
 *   memoised and will re-prompt if it recurs.
 * - Suppression never overrides a currently-applicable `"deny"`: when a key is
 *   remembered, `evaluate` re-runs the inner policy and lets a fresh `"deny"`
 *   win (e.g. a role was revoked since the call first executed). Only a
 *   non-deny decision is downgraded to `"allow"`.
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
 * The components are encoded as a single JSON array. Unlike a delimiter-joined
 * string (e.g. NUL-separated), a JSON array cannot be ambiguously split, so two
 * distinct component tuples can never serialise to the same key.
 */
export function canonicalKey(ctx: PolicyContext, policyVersion: string): string {
  return JSON.stringify([
    ctx.principal.userId,
    ctx.toolName,
    ctx.input,
    policyVersion,
  ]);
}

// ---------------------------------------------------------------------------
// rememberDecisions
// ---------------------------------------------------------------------------

/**
 * Wrap `inner` with an ask-once-remember layer.
 *
 * Behaviour:
 * - `evaluate`: if the store already holds this (principal, tool, args, version)
 *   key (the call has executed before), re-run `inner.evaluate` and return its
 *   decision if it is `"deny"`, otherwise `"allow"` (suppress the re-prompt by
 *   downgrading `approve`→`allow`, but let a now-applicable `deny` still win).
 *   If the key is absent, delegate straight to `inner`. `evaluate` records
 *   NOTHING.
 * - `onExecuted`: record the key ONLY when the enforced decision was
 *   `"approve"` (a human-approved call), then propagate to `inner.onExecuted`.
 *   An auto-`"allow"`ed call is NOT recorded — otherwise a later evaluation that
 *   now requires `"approve"` would be silently downgraded to `"allow"`, skipping
 *   an approval the user never gave. A denied call — whose `execute` the SDK
 *   skips — never reaches `onExecuted`, so it is never memoised either.
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
        // The call executed before. Re-run the inner policy so a freshly
        // applicable deny (e.g. revoked role) still wins — fail-closed. Any
        // non-deny decision is downgraded to "allow" to suppress the re-prompt.
        const current = await inner.evaluate(ctx);
        return current === "deny" ? "deny" : "allow";
      }

      return inner.evaluate(ctx);
    },
    async onExecuted(
      ctx: PolicyContext,
      decision: ApprovalDecision,
    ): Promise<void> {
      // Record only a human-approved execute — never an auto-allowed one, and
      // never at ask time. Remembering an allow would let it suppress a future
      // approval the user never granted.
      if (decision === "approve") {
        await store.set(canonicalKey(ctx, policyVersion), "approve");
      }
      await inner.onExecuted?.(ctx, decision);
    },
  };
}
