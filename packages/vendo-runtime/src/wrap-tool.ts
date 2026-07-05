/**
 * `wrapTool` — the enforcement seam where Vendo's guardrail policy governs a
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

import type { Tool, ToolExecutionOptions, UIMessageStreamWriter } from "ai";
import type { VendoUIMessage } from "@vendoai/core";
import type { ApprovalDecision, ApprovalPolicy, PolicyContext } from "./policy";
import type { ToolDescriptor } from "./descriptor";
import type { VendoPrincipal } from "./principal";
import { VendoError, policyDenied, approvalRequired } from "./errors";
import { dangerTier, isUnverified } from "./policy/tier";
import { getEscalationReason } from "./policy/escalation";
import type { RunPolicyContext } from "./policy/run-context";

/** Bounded so a long-lived process can't grow this without limit — same FIFO
 *  shape `judgePolicy`'s memo, `breakers.ts`'s `countedEscalationIds`, and
 *  `consent.ts`'s `ConsentLedger` all already use. */
const MAX_PAUSED_CALLS = 512;

/**
 * Tracks, per toolCallId, whether `needsApproval` actually paused for a human
 * (returned `true`) — the fail-closed signal `execute` checks before running
 * an "approve" decision (review follow-up, item 3).
 *
 * MUST be constructed ONCE and reused across every `wrapTool` call for the
 * same running agent, NOT recreated per call: `engine.ts` rebuilds the whole
 * toolset (and therefore a FRESH `wrapTool` closure) on every `run()` turn —
 * `needsApproval` and the LATER `execute` for the same human-in-the-loop call
 * happen on two SEPARATE turns, so a tracker scoped to one `wrapTool` call
 * would already be gone by the time `execute` needs to read it. Callers that
 * span turns (the engine) inject one instance via `WrapToolArgs.pausedCalls`,
 * mirroring how `engine.ts` already keeps `auditedClientCalls` alive across
 * turns instead of resetting it per run. A caller that never sets up
 * multi-turn plumbing (isolated unit tests, `wrapTool` called directly) gets
 * a private, per-call default — correct for those since they exercise
 * `needsApproval`/`execute` on the SAME wrapped-tool instance anyway.
 */
export interface PausedCallTracker {
  record(toolCallId: string): void;
  has(toolCallId: string): boolean;
}

/** A fresh in-memory {@link PausedCallTracker} — construct ONE per agent (or
 *  per handler mount) and reuse it across every run/turn. */
export function createPausedCallTracker(): PausedCallTracker {
  const seen = new Map<string, true>();
  return {
    record(toolCallId) {
      seen.set(toolCallId, true);
      if (seen.size > MAX_PAUSED_CALLS) {
        const oldest = seen.keys().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }
    },
    has: (toolCallId) => seen.has(toolCallId),
  };
}

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
  principal: VendoPrincipal;
  /** Stable per-conversation id threaded into PolicyContext (ENG-193 §4.3). */
  threadId?: string;
  /**
   * The run's stream writer (ENG-193 §4.5/§6.5). Optional — a caller with no
   * consent-card client (tests, the local F1 transport) simply gets no
   * data-consent parts, never a broken tool. When present, `needsApproval`
   * writes ONE persistent `data-consent` part for any NON-READ tool call,
   * regardless of the decision: an "approve" write lets the card render
   * tier/unverified before the user answers; an "allow" write is what lets a
   * settled mutating call still show a receipt (spec Moment 2 — asked, done,
   * never invisible). `needsApproval` runs for every tool call the SDK
   * generates (that's how it decides whether to pause), so this is the one
   * call site both cases need.
   */
  writer?: UIMessageStreamWriter<VendoUIMessage>;
  /**
   * The run's mutable judge context (ENG-193 §4.2) — request text, running
   * provenance/counters. Optional: a caller with no judge configured (or a
   * bare unit test) simply gets a PolicyContext missing these fields, which
   * every layer treats as "no signal available", never a crash.
   */
  runContext?: RunPolicyContext;
  /**
   * See {@link PausedCallTracker} — injected so it survives the multi-turn
   * needsApproval/execute gap. Absent -> a private per-call tracker (safe
   * only when both callbacks run against THIS SAME wrapped-tool instance,
   * e.g. isolated unit tests); production (`toolset.ts`/`engine.ts`) always
   * threads one instance through every turn.
   */
  pausedCalls?: PausedCallTracker;
}

/**
 * Wrap a raw ai SDK tool so its approval and execution are governed by the
 * guardrail policy.
 *
 * Shallow-clones the tool (preserving every SDK field) and overrides ONLY
 * `needsApproval` and `execute`. Throws `VendoError("policy", ...)` for a
 * tool with no callable `execute`, because a `deny` decision on such a tool
 * cannot be enforced (there is nothing to short-circuit) — refusing to wrap it
 * is the fail-closed choice.
 */
export function wrapTool(args: WrapToolArgs): Tool {
  const { name, tool, descriptor, policy, principal, threadId, writer, runContext } = args;

  // Fail-closed: without an `execute` to short-circuit, a `deny` cannot be
  // enforced. Refuse to wrap rather than silently let denied calls through.
  const originalExecute = tool.execute;
  if (descriptor.hasExecute === false || typeof originalExecute !== "function") {
    throw new VendoError(
      "policy",
      `cannot enforce deny on a no-execute tool: ${name}`,
    );
  }
  const boundExecute = originalExecute.bind(tool);

  // Review follow-up (item 3): `needsApproval` and `execute` run in SEPARATE
  // SDK turns; a stateful policy layer (breaker/rule/judge) can escalate its
  // decision from "allow" at needsApproval time to "approve" by the time
  // execute runs. The SDK only calls execute AFTER a human approves an
  // "approve" needsApproval outcome — so a fresh "approve" at execute time for
  // a toolCallId that never actually paused means this is an escalation NO
  // human has seen, not a normal approved resume. See `PausedCallTracker`'s
  // docstring for why this must be INJECTED, not created fresh per call, to
  // work across the real engine's per-turn toolset rebuild.
  const pausedCalls = args.pausedCalls ?? createPausedCallTracker();

  function buildCtx(input: unknown, toolCallId?: string): PolicyContext {
    return {
      toolName: name,
      input,
      descriptor,
      principal,
      toolCallId,
      threadId,
      request: runContext?.request,
      provenance: runContext?.snapshotProvenance(),
      counters: runContext?.snapshotCounters(),
    };
  }

  function writeConsentPart(toolCallId: string, reason: string | undefined): void {
    if (!writer) return;
    const tier = dangerTier(descriptor);
    if (tier === "read") return; // cards/receipts are for mutating calls only
    // A consent-metadata write is a side channel to the card/receipt — it must
    // never break the tool call itself (needsApproval's return value is what
    // actually gates execution). A throwing writer (a torn-down stream, a
    // client that closed early) is swallowed and logged, not propagated.
    try {
      writer.write({
        type: "data-consent",
        id: `consent-${toolCallId}`,
        data: {
          toolCallId,
          tier,
          unverified: isUnverified(descriptor),
          ...(reason ? { reason } : {}),
        },
      });
    } catch (err) {
      console.error(`[vendo] failed to write data-consent part for "${toolCallId}":`, err);
    }
  }

  // Preserve any caller-supplied output transform so we can delegate normal
  // (non-deny) outputs to it.
  const originalToModelOutput = (tool as Tool).toModelOutput;

  const wrapped = {
    ...tool,
    // Args-only predicate the SDK runs when the call is generated. Only
    // `"approve"` pauses for a human; `"allow"` and `"deny"` do not (deny is
    // enforced in `execute`, not by asking the user).
    needsApproval: async (input: unknown, options: { toolCallId: string }): Promise<boolean> => {
      // recordCall ONCE per generated call — the SDK calls needsApproval
      // exactly once per call regardless of the eventual decision, unlike
      // evaluate (called again in execute); see run-context.ts's docstring.
      runContext?.recordCall(name);
      const ctx = buildCtx(input, options.toolCallId);
      const decision = await policy.evaluate(ctx);
      writeConsentPart(options.toolCallId, getEscalationReason(ctx));
      if (decision === "approve") pausedCalls.record(options.toolCallId);
      return decision === "approve";
    },
    // Authoritative, fail-closed gate. ALWAYS re-evaluates the composed policy
    // fresh; a `deny` short-circuits the original execute.
    execute: async (input: unknown, options: ToolExecutionOptions) => {
      const ctx = buildCtx(input, options.toolCallId);
      const decision: ApprovalDecision = await policy.evaluate(ctx);
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
      if (decision === "approve" && !pausedCalls.has(options.toolCallId)) {
        // Fail closed: the fresh decision needs a human, but no pause was
        // ever recorded for THIS toolCallId (an escalation between the two
        // callbacks, or an execute reached with no prior needsApproval at
        // all). Refuse rather than silently run an unreviewed call — the
        // model should surface this and ask the user again.
        return approvalRequired(
          name,
          `Tool "${name}" now requires the user's approval before it can run — ask them again.`,
        );
      }
      const result = await boundExecute(input, options);
      // A result genuinely entered context — record it for taint tracking
      // BEFORE onExecuted, so any audit/breaker layer reacting to onExecuted
      // sees provenance that already reflects this call.
      runContext?.recordResult(name, descriptor);
      // Signal a genuine, successful execute, threading the FRESH execute-time
      // decision (`"allow"` or `"approve"`) so layers can distinguish an
      // auto-allowed call from a human-approved one. Only reached for non-deny
      // decisions and only after `boundExecute` resolves (a throw propagates
      // before this line, so a failed call is never recorded as executed).
      await policy.onExecuted?.(ctx, decision);
      return result;
    },
    // Guard the model-output transform against the deny/approval-required
    // payloads. When `execute` returns one of these, convert it to plain text
    // rather than letting a caller's `toModelOutput` (which expects the
    // tool's normal output shape) mis-handle it. Normal outputs delegate to
    // the original transform. When no original existed, leave `toModelOutput`
    // unset so the SDK applies its default (both payloads are plain
    // serialisable objects — safe).
    ...(originalToModelOutput
      ? {
          toModelOutput: (options: {
            toolCallId: string;
            input: unknown;
            output: unknown;
          }) => {
            const output = options.output as { code?: unknown } | null | undefined;
            if (output != null && typeof output === "object" && output.code === "policy_denied") {
              return {
                type: "text" as const,
                value: `Tool "${name}" was denied by the approval policy.`,
              };
            }
            if (
              output != null &&
              typeof output === "object" &&
              output.code === "approval_required"
            ) {
              return {
                type: "text" as const,
                value: `Tool "${name}" now requires the user's approval before it can run — ask them again.`,
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
