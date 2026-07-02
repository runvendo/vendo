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

import type { Tool } from "ai";
import type { ApprovalPolicy, PolicyContext } from "./policy";
import type { ToolDescriptor } from "./descriptor";
import type { FlowletPrincipal } from "./principal";
import { FlowletError } from "./errors";

/** Arguments to {@link wrapClientTool}. Mirrors `WrapToolArgs`. */
export interface WrapClientToolArgs {
  name: string;
  tool: Tool;
  descriptor: ToolDescriptor;
  policy: ApprovalPolicy;
  principal: FlowletPrincipal;
}

export function wrapClientTool(args: WrapClientToolArgs): Tool {
  const { name, tool, descriptor, policy, principal } = args;

  // A client-executed tool with a server execute is contradictory: the SDK
  // would run it in-process and the browser executor would never see it.
  if (descriptor.hasExecute === true || typeof tool.execute === "function") {
    throw new FlowletError(
      "policy",
      `client-executed tool must not carry an execute: ${name}`,
    );
  }

  function buildCtx(input: unknown): PolicyContext {
    return { toolName: name, input, descriptor, principal };
  }

  return {
    ...tool,
    needsApproval: async (input: unknown): Promise<boolean> => {
      const decision = await policy.evaluate(buildCtx(input));
      if (decision === "deny") {
        throw new FlowletError(
          "policy",
          `tool "${name}" denied by approval policy`,
        );
      }
      return decision === "approve";
    },
  };
}
