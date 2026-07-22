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

/** The bridge property carrying an OPEN tool's arguments (see
 *  {@link isOpenObjectSchema}). */
const OPEN_ARGS_KEY = "args";

/**
 * An OPEN tool input: an object schema with no declared properties that
 * accepts arbitrary fields (extraction emits these for routes whose body shape
 * it cannot type, e.g. `{type:"object", properties:{}, additionalProperties:
 * true}`). Mastra's provider schema-compat layers hard-close every object node
 * for strict-mode providers (the OpenAI layer sets `additionalProperties:
 * false` on all of them), so an open schema reaches the model as "this tool
 * takes NO arguments" — and the model dutifully calls it with `{}` even when
 * the user dictated exact args (0.4.x E2E, report-mastra defect 5: the
 * approved call then executed with an empty body). A schema with declared
 * properties survives those transforms, so open inputs ride a single declared
 * JSON-string property instead, unwrapped in execute before the guard.
 */
function isOpenObjectSchema(schema: unknown): boolean {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return false;
  const record = schema as Record<string, unknown>;
  if (record.type !== undefined && record.type !== "object") return false;
  const properties = record.properties;
  const declared = typeof properties === "object" && properties !== null
    && Object.keys(properties).length > 0;
  return !declared && record.additionalProperties !== false;
}

function openArgsBridgeSchema(tool: string): JSONSchema7 {
  return {
    type: "object",
    properties: {
      [OPEN_ARGS_KEY]: {
        // Both forms validate at runtime; strict-mode providers ride the
        // string branch (their compat layer closes every object node), and
        // permissive providers may pass the object directly.
        type: ["string", "object"],
        description: `The arguments to pass to ${tool}: a JSON object, or that object encoded as one JSON string literal (e.g. {"field":"value"}). Include every field the request calls for; pass {} when there are none.`,
      },
    },
  };
}

/** Recover the real tool args from a bridged call: a JSON-string `args`
 *  (the advertised shape), a plain-object `args` (a model that skipped the
 *  encoding), or the raw payload itself (a provider that ignored the bridge). */
function unwrapOpenArgs(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input ?? {};
  const record = input as Record<string, unknown>;
  if (OPEN_ARGS_KEY in record) {
    const value = record[OPEN_ARGS_KEY];
    if (value === null || value === undefined) return {};
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed === "") return {};
      try {
        return JSON.parse(trimmed) as unknown;
      } catch {
        throw new VendoError(
          "validation",
          `${OPEN_ARGS_KEY} must be one JSON object literal (e.g. {"field":"value"}); the provided value did not parse as JSON`,
        );
      }
    }
    if (typeof value === "object" && !Array.isArray(value)) return value;
  }
  return record;
}

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
    registry: vendo.guardedTools,
    runner: vendo.agent.asRunner(),
    ...(options?.include === undefined ? {} : { include: options.include }),
    ...(options?.exclude === undefined ? {} : { exclude: options.exclude }),
  });
  const tools: Record<string, VendoMastraTool> = {};
  for (const entry of pack) {
    const bridged = isOpenObjectSchema(entry.inputSchema);
    tools[entry.name] = createTool({
      id: entry.name,
      description: entry.description,
      inputSchema: bridged ? openArgsBridgeSchema(entry.name) : entry.inputSchema as JSONSchema7,
      execute: (inputData, context) => entry.execute(bridged ? unwrapOpenArgs(inputData) : inputData, {
        ctx: runContextFrom(context),
        ...(context?.agent?.toolCallId === undefined ? {} : { callId: context.agent.toolCallId }),
      }),
    }) as VendoMastraTool;
  }
  return tools;
}
