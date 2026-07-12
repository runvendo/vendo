/**
 * `createVendoHandler()` options — zod-validated so a typo'd option name or
 * a wrong-shaped value fails at boot with a readable error instead of being
 * silently ignored. ZERO-CONFIG contract: every field is optional; the
 * defaults read `.env` + `.vendo/` and just work.
 */
import { z } from "zod";
import type { LanguageModel, ToolSet } from "ai";
import type {
  AuditLog,
  CompiledRuleStore,
  GrantStore,
  HostToolDefinition,
  RegisteredComponent,
  ThreadStore,
} from "@vendoai/core";
import type {
  ApprovalPolicy,
  BreakerState,
  FadeTracker,
  VendoPrincipal,
  InstructionContext,
  McpServerConfig,
  RegisteredTool,
} from "@vendoai/runtime";
import type { ConnectionsStore } from "./connections.js";
import { mcpServerArraySchema } from "./mcp-config.js";

export interface IntegrationCatalogEntry {
  /** Composio toolkit id (must match the shell's BrandIcon ids). */
  id: string;
  name: string;
}

export interface VendoHandlerOptions {
  /** Language model driving the loop. Default: anthropic(VENDO_MODEL ?? claude-sonnet-4-6). */
  model?: LanguageModel;
  /** Product name used in the default system prompt (e.g. "Maple"). */
  productName?: string;
  /** Full system-prompt override — a string, or a per-run builder receiving
   *  the live tool summary (spec §1). Prefer `instructionsExtra` for additions. */
  instructions?: string | ((ctx: InstructionContext) => string);
  /** Appended to the built default system prompt. */
  instructionsExtra?: string;
  /** Guardrail policy. Default: annotation + verb heuristic, fail-safe approve. */
  policy?: ApprovalPolicy;
  /** Extra server-executed tools (or a per-request factory). */
  tools?: ToolSet | (() => ToolSet);
  /** The app's registered host components (added to the prewired catalog). */
  components?: RegisteredComponent[];
  /** Host-API tool definitions; overrides `.vendo/tools.json`. */
  hostTools?: HostToolDefinition[];
  /** Where `.vendo/` lives. Default: `<cwd>/.vendo`. */
  vendoDir?: string;
  /**
   * Resolve the caller's identity. Providing this makes YOU the gate: return
   * null to reject (403). Without it the handler only serves local requests
   * (or any request when VENDO_ALLOW_REMOTE=1 — see guard.ts).
   */
  principal?: (req: Request) => VendoPrincipal | null | Promise<VendoPrincipal | null>;
  /** Extra agent-cache key material (e.g. a store generation for demo resets). */
  cacheKey?: () => string;
  /** Integrations catalog shown by the connect UI. Default: the standard set. */
  integrations?: IntegrationCatalogEntry[];
  /**
   * Host-declared MCP servers (Streamable HTTP). Tools are ingested through
   * the policy engine as source "mcp", prefixed `<name>_<tool>`. OVERRIDES
   * `.vendo/mcp.json` entirely when provided.
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
  /**
   * Store seam members backing grants, audit, thread persistence, and
   * breaker state (ENG-193 §6.1/§6.2/§4.7). Defaults: fresh in-memory
   * instances (reset on process restart). Inject when the host persists
   * these elsewhere.
   */
  store?: {
    grants?: GrantStore;
    audit?: AuditLog;
    threads?: ThreadStore;
    breakers?: BreakerState;
    /** ENG-193 §4.4 — inject to share fade tracking with a host-owned instance. */
    fadeTracker?: FadeTracker;
    /** ENG-193 item 6 — inject to persist compiled always-ask rules elsewhere. */
    rules?: CompiledRuleStore;
  };
  /** The judge model (ENG-193 §4.2). Default: undefined — the judge is
   *  IDENTITY (fail-safe rollout; item-2 behavior, unchanged) until a host
   *  opts in. */
  judgeModel?: LanguageModel;
  /**
   * Durable storage. Default: PGlite at `.vendo/data` (or `DATABASE_URL` /
   * `VENDO_DATA_DIR`) — durable by default, no config required. `false` =
   * in-memory (opt out explicitly). `autoMigrate` defaults to `true`; set
   * `false` to skip boot migrations and run them out-of-band (via the
   * exported `migrateVendoDatabase`).
   *
   * Test-env safety net: when `NODE_ENV === "test"` and this option is left
   * unset entirely, the handler behaves as if `storage: false` were passed
   * (silently — no on-disk PGlite dirs from test runs, no warning). Pass an
   * explicit value, including `false`, to opt back in even under
   * `NODE_ENV=test`. Corollary: never let NODE_ENV=test leak into a real
   * deploy — it silently disables durability with no warning.
   */
  storage?: false | { connectionString?: string; pglite?: { dataDir: string }; autoMigrate?: boolean };
  /**
   * Stable identity for sharing one Vendo world between the route handler
   * and startVendoScheduler when both pass options — set the same string
   * in both places. Unnecessary for zero-config installs.
   */
  bootKey?: string;
}

const fn = <T>() => z.custom<T>((v) => typeof v === "function");

const CONNECTIONS_STORE_METHODS = [
  "list",
  "connect",
  "disconnect",
  "connectedToolkits",
  "setConnectedAccount",
  "findByConnectedAccount",
] as const satisfies readonly (keyof ConnectionsStore)[];

const optionsSchema = z
  .object({
    model: z.custom<LanguageModel>((v) => typeof v === "string" || (typeof v === "object" && v !== null)).optional(),
    productName: z.string().min(1).optional(),
    instructions: z
      .union([z.string().min(1), fn<(ctx: InstructionContext) => string>()])
      .optional(),
    instructionsExtra: z.string().min(1).optional(),
    policy: z.custom<ApprovalPolicy>((v) => typeof v === "object" && v !== null && "evaluate" in (v as object)).optional(),
    tools: z.union([z.record(z.unknown()), fn<() => ToolSet>()]).optional(),
    components: z.array(z.custom<RegisteredComponent>((v) => typeof v === "object" && v !== null)).optional(),
    hostTools: z.array(z.custom<HostToolDefinition>((v) => typeof v === "object" && v !== null)).optional(),
    vendoDir: z.string().min(1).optional(),
    principal: fn<NonNullable<VendoHandlerOptions["principal"]>>().optional(),
    cacheKey: fn<() => string>().optional(),
    integrations: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) }).strict()).optional(),
    mcpServers: mcpServerArraySchema.optional(),
    // ALL six ConnectionsStore methods: integrations calls
    // connect/disconnect/setConnectedAccount and webhooks calls
    // findByConnectedAccount — a legacy (list + connectedToolkits only) store
    // must fail HERE, at boot, not at first runtime use.
    connections: z
      .custom<ConnectionsStore>(
        (v) =>
          typeof v === "object" && v !== null &&
          CONNECTIONS_STORE_METHODS.every(
            (m) => typeof (v as Record<string, unknown>)[m] === "function",
          ),
        {
          message:
            `the connections store must implement all of ${CONNECTIONS_STORE_METHODS.join(", ")} ` +
            `(the full ConnectionsStore interface — see @vendoai/server's connections.ts)`,
        },
      )
      .optional(),
    automations: z
      .union([z.literal(false), z.object({ tools: z.record(z.custom<RegisteredTool>()).optional() }).strict()])
      .optional(),
    maxSteps: z.number().int().positive().optional(),
    store: z
      .object({
        grants: z.custom<GrantStore>((v) => typeof v === "object" && v !== null).optional(),
        audit: z.custom<AuditLog>((v) => typeof v === "object" && v !== null).optional(),
        threads: z.custom<ThreadStore>((v) => typeof v === "object" && v !== null).optional(),
        breakers: z.custom<BreakerState>((v) => typeof v === "object" && v !== null).optional(),
        fadeTracker: z.custom<FadeTracker>((v) => typeof v === "object" && v !== null).optional(),
        rules: z.custom<CompiledRuleStore>((v) => typeof v === "object" && v !== null).optional(),
      })
      .strict()
      .optional(),
    judgeModel: z.custom<LanguageModel>((v) => typeof v === "string" || (typeof v === "object" && v !== null)).optional(),
    storage: z
      .union([
        z.literal(false),
        z
          .object({
            connectionString: z.string().min(1).optional(),
            pglite: z.object({ dataDir: z.string().min(1) }).strict().optional(),
            autoMigrate: z.boolean().optional(),
          })
          .strict(),
      ])
      .optional(),
    bootKey: z.string().min(1).optional(),
  })
  .strict();

/** Validate options; throws a readable error on unknown keys or bad shapes. */
export function parseHandlerOptions(raw: VendoHandlerOptions = {}): VendoHandlerOptions {
  const parsed = optionsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`createVendoHandler: invalid options — ${parsed.error.message}`);
  }
  return raw;
}
