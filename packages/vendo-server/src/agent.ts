/**
 * Agent assembly for the Next handler: the generic system prompt (identity,
 * render_view mechanics, brand guidance from `.vendo/theme.json`, component
 * catalogs, host-API capabilities, connect + automations guidance) and the
 * toolkit-keyed agent cache.
 *
 * Cache semantics (the reason a cache exists at all): each agent instance
 * memoizes its Composio ingestion per userId for its lifetime, so an agent
 * built before a toolkit was connected never picks the new toolkit up. Keying
 * the cache by the sorted connected-toolkit list (+ the host's `cacheKey`)
 * means connecting e.g. gmail builds a FRESH agent that ingests it.
 */
import type { LanguageModel, ToolSet } from "ai";
import type {
  VendoAgent,
  RegisteredComponent,
  ToolSummaryInput,
} from "@vendoai/core";
import {
  buildChatInstructions,
  capabilitySummary,
  novelComponentsSection,
} from "@vendoai/core";
import {
  createVendoAgent,
  buildBrandGuidance,
  type ApprovalPolicy,
  type VendoAgentConfig,
  type InstructionContext,
  type McpServerConfig,
} from "@vendoai/runtime";
import type { BrandTokens } from "@vendoai/components/theme";
import {
  prewiredComponents,
  brandToCssVars,
  componentPromptCatalog,
} from "@vendoai/components/descriptors";
import { buildAutomationInstructions } from "@vendoai/runtime";
import type { IntegrationCatalogEntry } from "./options.js";

export interface BuildInstructionsInput {
  productName: string;
  brand: BrandTokens;
  /** Host-registered components (beyond the prewired catalog). */
  components: RegisteredComponent[];
  /** Names of the host's own API tools (from the manifest), for capability text. */
  hostToolNames: string[];
  /** Connectable toolkit catalog — empty when integrations are off. */
  integrations: IntegrationCatalogEntry[];
  /** Whether the automations world is enabled. */
  automations: boolean;
  /** Host events available as automation triggers (compiler guidance). */
  automationEvents?: Array<{ name: string; description?: string; payloadFields?: string }>;
  /** Appended verbatim at the end when provided. */
  extra?: string;
  /** Live merged toolset (per-run, spec §7) — feeds the capability summary. */
  toolSummary?: ToolSummaryInput[];
}

export function buildInstructions(input: BuildInstructionsInput): string {
  const identity = [
    `You are ${input.productName}'s assistant, an agent embedded in ${input.productName}. You can answer`,
    "in plain text AND, when it helps, generate bespoke UI on demand via render_view.",
    "You are NOT limited to one domain, and you never refuse by claiming a domain limit.",
  ].join("\n");

  // Component knowledge is packages'/host's to render; the platform RULES
  // around it (novel codegen) come from the shared prompt core.
  const catalogParts = [
    "BUILDING BLOCKS (source:'prewired') — place these inside the nodes tree:",
    "- Layout primitives (containers take `children`; gap/padding accept xs|sm|md|lg|xl or a px number):",
    "  - Stack (column; gap, padding, align, justify), Row (gap, padding, align, justify, wrap), Grid (columns, gap, padding).",
    "  - Surface: a host-styled card panel (surface background, hairline border, brand radius, roomy",
    "    padding). USE THIS to group related content into cards instead of hand-rolling card styles.",
    "  - Divider: hairline separator ({ vertical: true } for column splits).",
    "  - Text: props { text, variant?, as?, align? }. Variants: 'label' (uppercase muted section label),",
    "    'value' (large tabular-numeral stat — pair label+value for KPIs), 'title', 'heading', 'muted',",
    "    'caption'. A Surface with a label Text, a value Text, and a caption is the host's stat-card idiom.",
    "  - Skeleton (loading placeholder).",
    "- Catalog components (use a matching name and the exact prop names shown):",
    componentPromptCatalog(prewiredComponents),
  ];
  if (input.components.length > 0) {
    catalogParts.push(
      "",
      "HOST COMPONENTS (source:'host') — the app's OWN components, pixel-identical to",
      "the product itself. When one fits, PREFER it over both catalog components and",
      "novel code. Reference by name with source:'host' and the exact props shown:",
      componentPromptCatalog(input.components),
    );
  }
  catalogParts.push(
    "",
    "Prefer these prewired blocks. Compose them into whatever layout the request needs",
    "— side-by-side panels, a dashboard, a table, a chart, mixed components.",
    "- Images: only data:image URIs render (the sandbox blocks remote image loads); do NOT",
    "  use http/https image URLs — they will not load.",
    "",
    novelComponentsSection(),
  );

  const capabilities =
    input.hostToolNames.length > 0
      ? [
          `HOST API — you can act through ${input.productName}'s OWN API as the signed-in user.`,
          `These tools call the app's real endpoints with the user's session: ${input.hostToolNames.join(", ")}.`,
          "Reads run freely; anything that writes or is unreviewed pauses for the user's",
          "explicit approval first — so don't refuse such requests, just call the tool and",
          "let the approval card do the gating.",
        ].join("\n")
      : undefined;

  const extras: string[] = [];
  if (input.automations) extras.push(buildAutomationInstructions({ hostEvents: input.automationEvents ?? [] }));
  if (input.extra) extras.push(input.extra);

  return buildChatInstructions({
    identity,
    // Grounds the ONLY name the model may call the host — failure C was the
    // agent inventing a product name in refusal prose.
    hostName: input.productName,
    brandGuidance: buildBrandGuidance({ tokens: brandToCssVars(input.brand) }),
    catalogs: catalogParts.join("\n"),
    ...(capabilities ? { capabilities } : {}),
    ...(input.toolSummary
      ? {
          toolSummary: capabilitySummary(
            input.toolSummary,
            input.integrations.map((i) => i.id),
          ),
        }
      : {}),
    ...(input.integrations.length > 0
      ? { toolkits: input.integrations.map((i) => i.id) }
      : {}),
    extras,
  });
}

export interface AgentFactoryConfig {
  model: LanguageModel;
  policy: ApprovalPolicy;
  /** String, or a per-run builder receiving the live tool summary (spec §1). */
  instructions: string | ((ctx: InstructionContext) => string);
  components: RegisteredComponent[];
  /**
   * Per-request host-supplied server tools (the mount's `tools` option ONLY).
   * Judged/breaker-gated normally (source "engine") — ENG-193 PR #40 review
   * (item A): never merge authoring/steering tools in here.
   */
  tools?: () => ToolSet;
  /**
   * Per-request Vendo control-plane tools (automation authoring + steering)
   * the handler assembles itself. Merged under source "control" — the ONLY
   * source the judge/breakers exempt (ENG-193 PR #40 review — item A).
   */
  controlTools?: () => ToolSet;
  /** Connected Composio toolkits to ingest (undefined = Composio off). The
   *  connections store this reads from is durable-or-in-memory, so it's
   *  always async — a sync return also works (awaiting a non-promise is a
   *  no-op). */
  toolkits?: () => string[] | Promise<string[]>;
  /** Host-declared MCP servers (already env-resolved). Empty/undefined = MCP off. */
  mcpServers?: McpServerConfig[];
  /** Extra cache-key material from the host (e.g. store generation). */
  cacheKey?: () => string;
  maxSteps?: number;
  /**
   * Settled-run persistence hook (ENG-193 §6.2), passed straight to every
   * cached agent. It receives the run's threadId, so one fixed hook can
   * attribute each settled message list to the right conversation.
   */
  onSettled?: VendoAgentConfig["onSettled"];
  /** ENG-193 review follow-up — audits client-executed tool calls; see
   *  `VendoAgentConfig.audit`. Passed straight to every cached agent. */
  audit?: VendoAgentConfig["audit"];
  /** Maps the run principal onto the audit Principal shape; see
   *  `VendoAgentConfig.auditPrincipal`. */
  auditPrincipal?: VendoAgentConfig["auditPrincipal"];
}

/**
 * Toolkit-keyed agent cache. The Map stays bounded in practice: keys are
 * combinations of the (small) toolkit catalog plus the host cache key.
 */
export function createAgentCache(config: AgentFactoryConfig): () => Promise<VendoAgent> {
  const agents = new Map<string, VendoAgent>();
  return async () => {
    const toolkits = config.toolkits ? [...(await config.toolkits())].sort() : [];
    const key = `${config.cacheKey?.() ?? ""}:${toolkits.join(",")}`;
    let agent = agents.get(key);
    if (!agent) {
      agent = createVendoAgent({
        model: config.model,
        policy: config.policy,
        instructions: config.instructions,
        // Only ingest toolkits the user actually CONNECTED. Requesting an
        // unconnected toolkit makes the Composio fetch fail and the agent ends
        // up with NO tools at all — an empty list is the fail-closed default.
        ...(config.toolkits ? { composio: { config: { toolkits } } } : {}),
        // MCP servers are host-level and fixed for the handler's lifetime, so
        // they need no cache-key material (unlike connected toolkits).
        ...(config.mcpServers && config.mcpServers.length > 0
          ? { mcp: { servers: config.mcpServers } }
          : {}),
        ...(config.tools ? { tools: config.tools() } : {}),
        ...(config.controlTools ? { controlTools: config.controlTools() } : {}),
        ...(config.maxSteps !== undefined ? { maxSteps: config.maxSteps } : {}),
        ...(config.onSettled ? { onSettled: config.onSettled } : {}),
        ...(config.audit ? { audit: config.audit } : {}),
        ...(config.auditPrincipal ? { auditPrincipal: config.auditPrincipal } : {}),
        components: config.components,
      });
      agents.set(key, agent);
    }
    return agent;
  };
}
