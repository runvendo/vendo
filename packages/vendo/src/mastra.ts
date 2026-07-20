import { buildVendoToolPack, type VendoToolPackFilter } from "@vendoai/agent";
import { VendoError, type Principal, type RunContext } from "@vendoai/core";
// Static import of an OPTIONAL peer: this module only loads when the host
// imports `@vendoai/vendo/mastra`, and a Mastra host has @mastra/core by
// definition. Nothing outside this subpath touches it.
import { createTool, type Tool } from "@mastra/core/tools";
import type { ToolExecutionContext } from "@mastra/core/tools";
import type { JSONSchema7 } from "json-schema";
import type { Vendo } from "./server.js";

/**
 * `@vendoai/vendo/mastra` — the BYO-agent seam for Mastra agents (frozen
 * contract: docs/superpowers/specs/2026-07-20-existing-agents-contracts.md §2,
 * async return amended Wave 1). The same framework-neutral tool pack as
 * `./ai-sdk`, in Mastra `createTool` shape for the `Agent({ tools })` map.
 *
 * A Mastra agent definition is STATIC — one definition serves every user — so
 * this shim takes no principal. Each call resolves its principal (and optional
 * session id) lazily from Mastra's request context:
 *
 * ```ts
 * const requestContext = new RequestContext();
 * requestContext.set(VENDO_PRINCIPAL_KEY, { kind: "user", subject: userId });
 * requestContext.set(VENDO_SESSION_KEY, hostSessionId); // optional
 * await agent.stream(messages, { requestContext });
 * ```
 */

export {
  VENDO_CREATE_APP_TOOL,
  VENDO_DELEGATE_TOOL,
  VENDO_TOOL_PACK_PREFIX,
  type VendoDelegateResult,
  type VendoToolPackFilter,
} from "@vendoai/agent";

/** Request-context key holding the caller's Vendo `Principal` (`{ kind, subject }`).
 *  REQUIRED on every request that may reach a `vendo_*` tool — a missing or
 *  malformed principal fails the call closed. */
export const VENDO_PRINCIPAL_KEY = "vendo-principal";

/** Optional request-context key carrying the host session id into Vendo's
 *  audit trail; unset, the shim mints one per call. */
export const VENDO_SESSION_KEY = "vendo-session-id";

export type VendoMastraTool = Tool<unknown, unknown>;

function principalFrom(context: ToolExecutionContext | undefined): Principal {
  const candidate = context?.requestContext?.get(VENDO_PRINCIPAL_KEY) as Principal | undefined;
  if (typeof candidate?.kind !== "string" || typeof candidate.subject !== "string") {
    throw new VendoError(
      "validation",
      `vendo tools need the caller's principal: set requestContext "${VENDO_PRINCIPAL_KEY}" to { kind, subject } before invoking the agent`,
    );
  }
  return candidate;
}

function runContextFrom(context: ToolExecutionContext | undefined): RunContext {
  const session = context?.requestContext?.get(VENDO_SESSION_KEY);
  return {
    principal: principalFrom(context),
    // The frozen BYO context tuple — a chat surface that is not Vendo's, with
    // the user present. Park-and-resume replays pin this tuple.
    venue: "chat",
    presence: "present",
    sessionId: typeof session === "string" && session.length > 0
      ? session
      : `session_${globalThis.crypto.randomUUID()}`,
  };
}

/**
 * Build the Vendo tool pack as Mastra tools. Async (the pack enumerates the
 * live registry), which composes with a static agent either way:
 *
 * ```ts
 * // ESM top-level await:
 * const agent = new Agent({ tools: { ...weatherTool, ...(await vendoMastraTools(vendo)) } });
 * // or Mastra's dynamic tools function:
 * const agent = new Agent({ tools: () => vendoMastraTools(vendo) });
 * ```
 *
 * A `vendo_*` tool returns either a versioned envelope — `vendo/app-ref@1`
 * (render with `<VendoAppEmbed>`) or `vendo/approval-ref@1` (parks server-side;
 * render with `<VendoApprovalEmbed>`) — or plain data, meaning the guarded
 * call executed cleanly.
 */
export async function vendoMastraTools(
  vendo: Vendo,
  options?: VendoToolPackFilter,
): Promise<Record<string, VendoMastraTool>> {
  const pack = await buildVendoToolPack({
    registry: vendo.guard.bind(vendo.actions),
    runner: vendo.agent.asRunner(),
    ...(options?.include === undefined ? {} : { include: options.include }),
    ...(options?.exclude === undefined ? {} : { exclude: options.exclude }),
  });
  const tools: Record<string, VendoMastraTool> = {};
  for (const entry of pack) {
    tools[entry.name] = createTool({
      id: entry.name,
      description: entry.description,
      inputSchema: entry.inputSchema as JSONSchema7,
      execute: (inputData, context) => entry.execute(inputData, {
        ctx: runContextFrom(context),
        ...(context?.agent?.toolCallId === undefined ? {} : { callId: context.agent.toolCallId }),
      }),
    }) as VendoMastraTool;
  }
  return tools;
}
