import { buildVendoToolPack } from "@vendoai/agent";
import { VendoError, type RunContext } from "@vendoai/core";
import { dynamicTool, jsonSchema, type ToolSet } from "ai";
import type { Vendo } from "./server.js";

/**
 * `@vendoai/vendo/ai-sdk` — the BYO-agent seam for AI SDK loops (frozen
 * contract: docs/superpowers/specs/2026-07-20-existing-agents-contracts.md §2).
 * One thin format shim over the framework-neutral tool pack in
 * `@vendoai/agent`, executing through `vendo.guardedTools` — the guard-bound
 * registry Vendo's own loop shares, decorated to park pending-approval calls
 * so `<VendoApprovalEmbed>` can resume them over the wire — plus
 * `agent.asRunner()` behind `vendo_delegate`. No tool reachable from the host
 * loop has an unguarded route.
 */

export {
  VENDO_CREATE_APP_TOOL,
  VENDO_DELEGATE_TOOL,
  VENDO_TOOL_PACK_PREFIX,
  type VendoDelegateResult,
  type VendoToolPackFilter,
  type VendoToolPackOptions,
} from "@vendoai/agent";
import type { VendoToolPackOptions } from "@vendoai/agent";

/**
 * Build the Vendo tool pack as an AI SDK `ToolSet` for `streamText`/
 * `generateText`. Built PER REQUEST: tool execution needs a principal-scoped
 * RunContext, so resolve the caller's principal first and spread the result
 * into your route handler's `tools`:
 *
 * ```ts
 * const result = streamText({
 *   model,
 *   messages,
 *   tools: { ...myTools, ...(await vendoTools(vendo, { principal })) },
 * });
 * ```
 *
 * A `vendo_*` tool returns either a versioned envelope — `vendo/app-ref@1`
 * (render with `<VendoAppEmbed>`) or `vendo/approval-ref@1` (parks server-side;
 * render with `<VendoApprovalEmbed>`) — or plain data, meaning the guarded call
 * executed cleanly. `options.sessionId` carries the host session id into audit;
 * unset, the shim mints one per pack build.
 */
export async function vendoTools(vendo: Vendo, options: VendoToolPackOptions): Promise<ToolSet> {
  if (typeof options?.principal?.kind !== "string" || typeof options.principal.subject !== "string") {
    throw new VendoError("validation", "vendoTools requires a principal — resolve the host session's user before building the pack");
  }
  // The frozen context tuple for a BYO loop: a chat surface that is not
  // Vendo's, with the user present. Park-and-resume replays pin this tuple.
  const ctx: RunContext = {
    principal: options.principal,
    venue: "chat",
    presence: "present",
    sessionId: options.sessionId ?? `session_${globalThis.crypto.randomUUID()}`,
  };
  const pack = await buildVendoToolPack({
    registry: vendo.guardedTools,
    runner: vendo.agent.asRunner(),
    ...(options.include === undefined ? {} : { include: options.include }),
    ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
  });
  const tools: ToolSet = {};
  for (const entry of pack) {
    tools[entry.name] = dynamicTool({
      description: entry.description,
      inputSchema: jsonSchema(entry.inputSchema as Parameters<typeof jsonSchema>[0]),
      execute: (input, { toolCallId }) => entry.execute(input, { ctx, callId: toolCallId }),
    });
  }
  return tools;
}
