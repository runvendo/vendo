/**
 * `wrapClientTool` — policy governance for a CLIENT-EXECUTED tool (a host-API
 * tool that runs in the user's browser, ENG-202 / topology B).
 *
 * Unlike `wrapTool`, there is no server-side `execute` to act as the
 * authoritative gate — execution happens in the browser after the SDK's
 * native approval round-trip. The policy is therefore enforced at the ONE
 * server-side chokepoint that exists for these tools, `needsApproval`
 * (evaluated when the model generates the call):
 *
 * - `"allow"`   → no approval; the client executes on stream settle.
 * - `"approve"` → the SDK emits an approval request (existing approval cards);
 *                 the client executes only after the user approves. A decline
 *                 is synthesised into an execution-denied result by the SDK.
 * - `"deny"`    → fail-closed: throw. The SDK surfaces a stream error part and
 *                 the tool is never executed. A hard deny must not become an
 *                 approval card a human could override.
 *
 * Note the residual trust model: for client tools the browser is the executor,
 * and the browser belongs to the very user whose credentials authorize the
 * call — client-side enforcement guards the AGENT, while the host API remains
 * the real security boundary for the user.
 */

import type { Tool, UIMessageStreamWriter } from "ai";
import type { FlowletUIMessage } from "@flowlet/core";
import type { ApprovalPolicy, PolicyContext } from "./policy";
import type { ToolDescriptor } from "./descriptor";
import type { FlowletPrincipal } from "./principal";
import { FlowletError } from "./errors";
import { dangerTier, isUnverified } from "./policy/tier";
import { getEscalationReason } from "./policy/escalation";
import type { RunPolicyContext } from "./policy/run-context";

/** Arguments to {@link wrapClientTool}. Mirrors `WrapToolArgs`. */
export interface WrapClientToolArgs {
  name: string;
  tool: Tool;
  descriptor: ToolDescriptor;
  policy: ApprovalPolicy;
  principal: FlowletPrincipal;
  /** Stable per-conversation id threaded into PolicyContext (ENG-193 §4.3). */
  threadId?: string;
  /**
   * The run's stream writer (ENG-193 §4.5/§6.5). See `WrapToolArgs.writer` —
   * same contract, mirrored here for client-executed tools.
   */
  writer?: UIMessageStreamWriter<FlowletUIMessage>;
  /** See `WrapToolArgs.runContext` — same contract, mirrored for
   *  client-executed tools. NOTE: client tools have no server-side `execute`,
   *  so `recordResult` is never called for them — their results can never
   *  taint provenance in v1 (documented limitation, run-context.ts). */
  runContext?: RunPolicyContext;
}

export function wrapClientTool(args: WrapClientToolArgs): Tool {
  const { name, tool, descriptor, policy, principal, threadId, writer, runContext } = args;

  // A client-executed tool with a server execute is contradictory: the SDK
  // would run it in-process and the browser executor would never see it.
  if (descriptor.hasExecute === true || typeof tool.execute === "function") {
    throw new FlowletError(
      "policy",
      `client-executed tool must not carry an execute: ${name}`,
    );
  }

  function buildCtx(input: unknown, toolCallId?: string): PolicyContext {
    return {
      toolName: name,
      input,
      descriptor,
      principal,
      threadId,
      toolCallId,
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
        data: { toolCallId, tier, unverified: isUnverified(descriptor), ...(reason ? { reason } : {}) },
      });
    } catch (err) {
      console.error(`[flowlet] failed to write data-consent part for "${toolCallId}":`, err);
    }
  }

  return {
    ...tool,
    needsApproval: async (input: unknown, options: { toolCallId: string }): Promise<boolean> => {
      runContext?.recordCall(name);
      const ctx = buildCtx(input, options.toolCallId);
      const decision = await policy.evaluate(ctx);
      if (decision === "deny") {
        throw new FlowletError(
          "policy",
          `tool "${name}" denied by approval policy`,
        );
      }
      writeConsentPart(options.toolCallId, getEscalationReason(ctx));
      return decision === "approve";
    },
  };
}
