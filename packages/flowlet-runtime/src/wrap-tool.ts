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
  const { name, tool, descriptor, policy, principal } = args;

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

  function buildCtx(input: unknown, toolCallId?: string): PolicyContext {
    return { toolName: name, input, descriptor, principal, toolCallId };
  }

  /**
   * Evaluate the composed policy for this input — ALWAYS fresh, never cached.
   * Both `needsApproval` (preflight) and `execute` (the later approval turn)
   * call this, so each re-runs the full composed policy. That is the fail-closed
   * guarantee: a policy whose state changed between the two callbacks (role
   * revoked, threshold lowered) is re-evaluated at execute time and enforced.
   * The expensive NL judge memoises its own result internally, so re-evaluation
   * is cheap without weakening freshness of the deterministic layers.
   */
  async function evaluate(input: unknown): Promise<ApprovalDecision> {
    return policy.evaluate(buildCtx(input));
  }

  // Preserve any caller-supplied output transform so we can delegate normal
  // (non-deny) outputs to it.
  const originalToModelOutput = (tool as Tool).toModelOutput;

  const wrapped = {
    ...tool,
    // Args-only predicate the SDK runs when the call is generated. Only
    // `"approve"` pauses for a human; `"allow"` and `"deny"` do not (deny is
    // enforced in `execute`, not by asking the user).
    needsApproval: async (input: unknown): Promise<boolean> =>
      (await evaluate(input)) === "approve",
    // Authoritative, fail-closed gate. ALWAYS re-evaluates the composed policy
    // fresh; a `deny` short-circuits the original execute.
    execute: async (input: unknown, options: ToolExecutionOptions) => {
      const decision = await evaluate(input);
      if (decision === "deny") {
        // Return the structured deny payload as the tool result so the model
        // sees the refusal. Verified against ai@6.0.28: the live run path
        // (executeTool → executeToolCall) does NOT validate an execute return
        // against the tool's `outputSchema` (only the opt-in validateUIMessages
        // utility does), so this object is safe even for a tool whose
        // `outputSchema` is non-object (e.g. `z.string()`). `onExecuted` is NOT
        // called: the real tool never ran.
        return policyDenied(name, "denied by approval policy");
      }
      const result = await boundExecute(input, options);
      // Signal a genuine, successful execute, threading the FRESH execute-time
      // decision (`"allow"` or `"approve"`) so layers can distinguish an
      // auto-allowed call from a human-approved one. Only reached for non-deny
      // decisions and only after `boundExecute` resolves (a throw propagates
      // before this line, so a failed call is never recorded as executed).
      await policy.onExecuted?.(buildCtx(input, options.toolCallId), decision);
      return result;
    },
    // Guard the model-output transform against the deny payload. When `execute`
    // returns a `policy_denied` object, convert it to plain text rather than
    // letting a caller's `toModelOutput` (which expects the tool's normal output
    // shape) mis-handle it. Normal outputs delegate to the original transform.
    // When no original existed, leave `toModelOutput` unset so the SDK applies
    // its default (the deny payload is a plain serialisable object — safe).
    ...(originalToModelOutput
      ? {
          toModelOutput: (options: {
            toolCallId: string;
            input: unknown;
            output: unknown;
          }) => {
            const output = options.output as { code?: unknown } | null | undefined;
            if (
              output != null &&
              typeof output === "object" &&
              output.code === "policy_denied"
            ) {
              return {
                type: "text" as const,
                value: `Tool "${name}" was denied by the approval policy.`,
              };
            }
            return originalToModelOutput(
              options as Parameters<typeof originalToModelOutput>[0],
            );
          },
        }
      : {}),
  };

  return wrapped as Tool;
}
