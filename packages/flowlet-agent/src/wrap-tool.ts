/**
 * `wrapTool` — the enforcement seam where Flowlet's guardrail policy governs a
 * raw ai SDK tool's approval and execution.
 *
 * The ai SDK runs a human-in-the-loop tool call across TWO separate `run()`
 * turns: `needsApproval(input, options)` decides (when the call is generated)
 * whether to pause for approval, and `execute(input, options)` runs in a LATER
 * turn after the client approves. The SDK does NOT re-call `needsApproval` for
 * an approved call, so any state set in `needsApproval` is gone by the time
 * `execute` runs.
 *
 * Consequence: `execute` is the authoritative, fail-closed gate. It always
 * re-evaluates the policy itself and never trusts that `needsApproval` ran or
 * what it decided.
 */

import type { Tool, ToolExecutionOptions } from "ai";
import type { ApprovalDecision, ApprovalPolicy, PolicyContext } from "./policy";
import { canonicalKey } from "./policy";
import type { ToolDescriptor } from "./descriptor";
import type { FlowletPrincipal } from "./principal";
import { FlowletError, policyDenied } from "./errors";

/** Arguments to {@link wrapTool}. */
export interface WrapToolArgs {
  /** Canonical tool name, used in the policy context and in deny payloads. */
  name: string;
  /** The raw ai SDK tool to govern. */
  tool: Tool;
  /** Normalised descriptor captured at registration time. */
  descriptor: ToolDescriptor;
  /** The (already composed) guardrail policy. */
  policy: ApprovalPolicy;
  /** Identity on whose behalf the agent acts. */
  principal: FlowletPrincipal;
  /**
   * Optional per-run cache so an expensive judge is not evaluated twice in the
   * SAME turn (e.g. once in `needsApproval`, once in `execute`). It is an
   * optimisation only — never relied upon across turns.
   */
  decisionCache?: Map<string, ApprovalDecision>;
  /** Policy version string mixed into the cache key. Defaults to `"v1"`. */
  policyVersion?: string;
}

/**
 * Wrap a raw ai SDK tool so its approval and execution are governed by the
 * guardrail policy.
 *
 * Shallow-clones the tool (preserving every SDK field) and overrides ONLY
 * `needsApproval` and `execute`. Throws `FlowletError("policy", ...)` for a
 * tool with no callable `execute`, because a `deny` decision on such a tool
 * cannot be enforced (there is nothing to short-circuit) — refusing to wrap it
 * is the fail-closed choice.
 */
export function wrapTool(args: WrapToolArgs): Tool {
  const { name, tool, descriptor, policy, principal, decisionCache } = args;
  const policyVersion = args.policyVersion ?? "v1";

  // Fail-closed: without an `execute` to short-circuit, a `deny` cannot be
  // enforced. Refuse to wrap rather than silently let denied calls through.
  const originalExecute = tool.execute;
  if (descriptor.hasExecute === false || typeof originalExecute !== "function") {
    throw new FlowletError(
      "policy",
      `cannot enforce deny on a no-execute tool: ${name}`,
    );
  }
  const boundExecute = originalExecute.bind(tool);

  /**
   * Evaluate the policy for this input. With a `decisionCache`, an identical
   * (principal, tool, args, version) lookup is served from cache so the policy
   * runs at most once per turn for the same call.
   */
  async function evaluate(input: unknown): Promise<ApprovalDecision> {
    const ctx: PolicyContext = { toolName: name, input, descriptor, principal };
    if (decisionCache) {
      const key = canonicalKey(ctx, policyVersion);
      const cached = decisionCache.get(key);
      if (cached !== undefined) return cached;
      const decision = await policy.evaluate(ctx);
      decisionCache.set(key, decision);
      return decision;
    }
    return policy.evaluate(ctx);
  }

  const wrapped = {
    ...tool,
    // Args-only predicate the SDK runs when the call is generated. Only
    // `"approve"` pauses for a human; `"allow"` and `"deny"` do not (deny is
    // enforced in `execute`, not by asking the user).
    needsApproval: async (input: unknown): Promise<boolean> =>
      (await evaluate(input)) === "approve",
    // Authoritative, fail-closed gate. Re-evaluates the policy in this turn
    // (a cold cache evaluates fresh); a `deny` short-circuits the original.
    execute: async (input: unknown, options: ToolExecutionOptions) => {
      const decision = await evaluate(input);
      if (decision === "deny") {
        return policyDenied(name, "denied by approval policy");
      }
      return boundExecute(input, options);
    },
  };

  return wrapped as Tool;
}
