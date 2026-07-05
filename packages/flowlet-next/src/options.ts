/**
 * `createFlowletHandler()` options — zod-validated so a typo'd option name or
 * a wrong-shaped value fails at boot with a readable error instead of being
 * silently ignored. ZERO-CONFIG contract: every field is optional; the
 * defaults read `.env` + `.flowlet/` and just work.
 */
import { z } from "zod";
import type { LanguageModel, ToolSet } from "ai";
import type { HostToolDefinition, RegisteredComponent } from "@flowlet/core";
import type { ApprovalPolicy, FlowletPrincipal, McpServerConfig, RegisteredTool } from "@flowlet/runtime";
import type { ConnectionsStore } from "./connections";
import { mcpServerArraySchema } from "./mcp-config";

export interface IntegrationCatalogEntry {
  /** Composio toolkit id (must match the shell's BrandIcon ids). */
  id: string;
  name: string;
}

export interface FlowletHandlerOptions {
  /** Language model driving the loop. Default: anthropic(FLOWLET_MODEL ?? claude-sonnet-4-6). */
  model?: LanguageModel;
  /** Product name used in the default system prompt (e.g. "Maple"). */
  productName?: string;
  /** Full system-prompt override. Prefer `instructionsExtra` for additions. */
  instructions?: string;
  /** Appended to the built default system prompt. */
  instructionsExtra?: string;
  /** Guardrail policy. Default: annotation + verb heuristic, fail-safe approve. */
  policy?: ApprovalPolicy;
  /** Extra server-executed tools (or a per-request factory). */
  tools?: ToolSet | (() => ToolSet);
  /** The app's registered host components (added to the prewired catalog). */
  components?: RegisteredComponent[];
  /** Host-API tool definitions; overrides `.flowlet/tools.json`. */
  hostTools?: HostToolDefinition[];
  /** Where `.flowlet/` lives. Default: `<cwd>/.flowlet`. */
  flowletDir?: string;
  /**
   * Resolve the caller's identity. Providing this makes YOU the gate: return
   * null to reject (403). Without it the handler only serves local requests
   * (or any request when FLOWLET_ALLOW_REMOTE=1 — see guard.ts).
   */
  principal?: (req: Request) => FlowletPrincipal | null | Promise<FlowletPrincipal | null>;
  /** Extra agent-cache key material (e.g. a store generation for demo resets). */
  cacheKey?: () => string;
  /** Integrations catalog shown by the connect UI. Default: the standard set. */
  integrations?: IntegrationCatalogEntry[];
  /**
   * Host-declared MCP servers (Streamable HTTP). Tools are ingested through
   * the policy engine as source "mcp", prefixed `<name>_<tool>`. OVERRIDES
   * `.flowlet/mcp.json` entirely when provided.
   */
  mcpServers?: McpServerConfig[];
  /**
   * Bring-your-own connections store (which toolkits are connected → what the
   * agent ingests). Default: a fresh in-memory store. Inject when the host
   * owns connection state elsewhere (e.g. a demo reset that clears it).
   */
  connections?: ConnectionsStore;
  /**
   * Automations world. `false` disables it (no authoring tools, tick 404s);
   * `tools` registers server-executed tools automation steps may call.
   */
  automations?: false | { tools?: Record<string, RegisteredTool> };
  /** Max model->tool steps per turn. Default: engine default. */
  maxSteps?: number;
}

const fn = <T>() => z.custom<T>((v) => typeof v === "function");

const optionsSchema = z
  .object({
    model: z.custom<LanguageModel>((v) => typeof v === "string" || (typeof v === "object" && v !== null)).optional(),
    productName: z.string().min(1).optional(),
    instructions: z.string().min(1).optional(),
    instructionsExtra: z.string().min(1).optional(),
    policy: z.custom<ApprovalPolicy>((v) => typeof v === "object" && v !== null && "evaluate" in (v as object)).optional(),
    tools: z.union([z.record(z.unknown()), fn<() => ToolSet>()]).optional(),
    components: z.array(z.custom<RegisteredComponent>((v) => typeof v === "object" && v !== null)).optional(),
    hostTools: z.array(z.custom<HostToolDefinition>((v) => typeof v === "object" && v !== null)).optional(),
    flowletDir: z.string().min(1).optional(),
    principal: fn<NonNullable<FlowletHandlerOptions["principal"]>>().optional(),
    cacheKey: fn<() => string>().optional(),
    integrations: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) }).strict()).optional(),
    mcpServers: mcpServerArraySchema.optional(),
    connections: z
      .custom<ConnectionsStore>(
        (v) =>
          typeof v === "object" && v !== null &&
          typeof (v as ConnectionsStore).connectedToolkits === "function" &&
          typeof (v as ConnectionsStore).list === "function",
      )
      .optional(),
    automations: z
      .union([z.literal(false), z.object({ tools: z.record(z.custom<RegisteredTool>()).optional() }).strict()])
      .optional(),
    maxSteps: z.number().int().positive().optional(),
  })
  .strict();

/** Validate options; throws a readable error on unknown keys or bad shapes. */
export function parseHandlerOptions(raw: FlowletHandlerOptions = {}): FlowletHandlerOptions {
  const parsed = optionsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`createFlowletHandler: invalid options — ${parsed.error.message}`);
  }
  return raw;
}
