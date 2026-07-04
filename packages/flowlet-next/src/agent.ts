/**
 * Agent assembly for the Next handler: the generic system prompt (identity,
 * render_view mechanics, brand guidance from `.flowlet/theme.json`, component
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
import type { FlowletAgent, RegisteredComponent } from "@flowlet/core";
import {
  createFlowletAgent,
  buildBrandGuidance,
  type ApprovalPolicy,
  type McpServerConfig,
} from "@flowlet/runtime";
import type { BrandTokens } from "@flowlet/components/theme";
import {
  prewiredComponents,
  brandToCssVars,
  componentPromptCatalog,
} from "@flowlet/components/descriptors";
import { buildAutomationInstructions } from "@flowlet/runtime";
import type { IntegrationCatalogEntry } from "./options";

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
  /** Appended verbatim at the end when provided. */
  extra?: string;
}

export function buildInstructions(input: BuildInstructionsInput): string {
  const sections: string[] = [
    `You are ${input.productName}'s assistant, an agent embedded in ${input.productName}. You can answer`,
    "in plain text AND, when it helps, generate bespoke UI on demand via render_view.",
    "You are NOT limited to one domain, and you never refuse by claiming a domain limit.",
    "",
    "WHEN TO RENDER UI vs. JUST TALK — this is important, get it right:",
    "- Call render_view ONLY when the user clearly wants something visual: they say",
    "  'show me', 'show', 'build', 'make', 'chart', 'graph', 'visualize', 'a table of',",
    "  'a dashboard', 'a view', 'a game', or ask a data/exploration question whose",
    "  answer is genuinely better as a chart/table/clock than a sentence.",
    "- For everything else — a simple question, a confirmation, an explanation, a",
    "  yes/no, small talk, or anything you can answer in a sentence or two — JUST",
    "  REPLY IN TEXT. Do NOT render a view. Most turns are text.",
    "- When unsure, default to text. Never render UI for random/simple things.",
    "",
    "If a request falls outside your data and tools, say so briefly and offer the",
    "closest thing — a flat refusal is never the right answer.",
    "",
    "Be concise. When you do render UI, let it carry the answer and keep text short.",
    "",
    "STYLE — strict: Never use emojis anywhere. Not in your text, and not in any",
    "rendered content: titles, subtitles, labels, tags, body copy, or any prop you",
    "pass to render_view. Plain text only. You may use light Markdown (bold, lists) in",
    "prose, but no emoji or decorative symbols. Write titles in plain Title Case.",
    "",
    // Data-driven brand section: rendered from the SAME tokens the sandbox
    // injects (one source of truth).
    buildBrandGuidance({ tokens: brandToCssVars(input.brand) }),
    "",
    "HOW render_view WORKS — there is ONE rendering tool. Every view you show is a",
    "single render_view call carrying ONE GeneratedPayload:",
    "- formatVersion: 'flowlet-genui/v1'.",
    "- root: the id of the root node.",
    "- nodes: a FLAT array of nodes, each with a unique `id`. One node is the `root`;",
    "  every other node is reached because some node lists its id in `children`.",
    "- Each node: { id, component, source, props, children? }. Pass props as a JSON",
    "  OBJECT — never a stringified JSON string.",
    "- data (optional): a shared data model. Bind a prop to it with { $path: '/json/pointer' }.",
    "- A single component is just a one-node view: root points at that one node.",
    "",
    "REFRESHABLE VIEWS — when a view presents data you fetched with a tool, make it",
    "re-runnable: put the tool's result VERBATIM at one path in `data`, bind props",
    "into that subtree with { $path } or transform it inside a generated component,",
    "and declare queries: [{ path: '/x', tool: '<tool>', input: {...} }]. Saved views",
    "re-run those queries on reopen to show fresh data. Do NOT reshape tool output",
    "before storing it at the declared path — reshape at render time.",
    "",
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
    sections.push(
      "",
      "HOST COMPONENTS (source:'host') — the app's OWN components, pixel-identical to",
      "the product itself. When one fits, PREFER it over both catalog components and",
      "novel code. Reference by name with source:'host' and the exact props shown:",
      componentPromptCatalog(input.components),
    );
  }

  sections.push(
    "",
    "Prefer these prewired blocks. Compose them into whatever layout the request needs",
    "— side-by-side panels, a dashboard, a table, a chart, mixed components.",
    "- Images: only data:image URIs render (the sandbox blocks remote image loads); do NOT",
    "  use http/https image URLs — they will not load.",
    "",
    "NOVEL COMPONENTS (source:'generated') — when the catalog above cannot express what",
    "is asked (a custom visual, an interactive widget, an animation, or a GAME/calculator/",
    "drawing tool), do NOT print code as text and do NOT refuse. Instead WRITE the missing",
    "component as code and reference it:",
    "- Define it in the payload's `components` map: { PascalCaseName: \"<esm source>\" },",
    "  then add a node with component:'PascalCaseName' and source:'generated'.",
    "- You MAY write JSX/TSX — it is compiled server-side with the automatic React",
    "  runtime, so you do NOT need to import React:",
    "  export default function Name(props){ return <div>{props.title}</div>; }",
    "- A generated component is a real React component: it can own a <canvas>, timers,",
    "  keyboard/mouse handlers, and useState — so games and interactive widgets live here.",
    "- It runs in a network-jailed sandbox: fetch/XHR fail — do not use them. To perform",
    "  an app action, call props.flowlet.dispatch({ action: '<tool>', payload: {...} }).",
    "- Caps: at most 16 novel components; the authored source is capped at 64KB each.",
    "  Generate only what the catalog lacks.",
  );

  if (input.hostToolNames.length > 0) {
    sections.push(
      "",
      `HOST API — you can act through ${input.productName}'s OWN API as the signed-in user.`,
      `These tools call the app's real endpoints with the user's session: ${input.hostToolNames.join(", ")}.`,
      "Reads run freely; anything that writes or is unreviewed pauses for the user's",
      "explicit approval first — so don't refuse such requests, just call the tool and",
      "let the approval card do the gating.",
    );
  }

  if (input.integrations.length > 0) {
    sections.push(
      "",
      "CONNECTING TOOLS — external tools (Gmail, Slack, etc.) are only available once",
      "the user has CONNECTED them. If a request needs a tool that is not yet connected",
      "(you'll notice the tool simply isn't in your toolset), do NOT refuse and do NOT",
      "try to render Connect via render_view. Instead call the request_connect tool:",
      'request_connect({ toolkit: "<id>", reason: "<short why>" }). Use the toolkit id',
      `(${input.integrations.map((i) => i.id).join(", ")}). You may briefly say you're`,
      "requesting access. Once the user connects it, they can re-ask and you'll have the tool.",
    );
  }

  if (input.automations) {
    sections.push("", buildAutomationInstructions());
  }

  if (input.extra) {
    sections.push("", input.extra);
  }

  return sections.join("\n");
}

export interface AgentFactoryConfig {
  model: LanguageModel;
  policy: ApprovalPolicy;
  instructions: string;
  components: RegisteredComponent[];
  /** Per-request extra server tools (authoring tools + host `tools` option). */
  tools?: () => ToolSet;
  /** Connected Composio toolkits to ingest (undefined = Composio off). */
  toolkits?: () => string[];
  /** Host-declared MCP servers (already env-resolved). Empty/undefined = MCP off. */
  mcpServers?: McpServerConfig[];
  /** Extra cache-key material from the host (e.g. store generation). */
  cacheKey?: () => string;
  maxSteps?: number;
}

/**
 * Toolkit-keyed agent cache. The Map stays bounded in practice: keys are
 * combinations of the (small) toolkit catalog plus the host cache key.
 */
export function createAgentCache(config: AgentFactoryConfig): () => FlowletAgent {
  const agents = new Map<string, FlowletAgent>();
  return () => {
    const toolkits = config.toolkits ? [...config.toolkits()].sort() : [];
    const key = `${config.cacheKey?.() ?? ""}:${toolkits.join(",")}`;
    let agent = agents.get(key);
    if (!agent) {
      agent = createFlowletAgent({
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
        ...(config.maxSteps !== undefined ? { maxSteps: config.maxSteps } : {}),
        components: config.components,
      });
      agents.set(key, agent);
    }
    return agent;
  };
}
