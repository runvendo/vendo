/**
 * Server-only Vendo agent for the Maple demo.
 *
 * Builds the real `createVendoAgent` (anthropic model + a broad Composio toolkit
 * set + the real `demoPolicy` guardrail) and a general-purpose, generative-UI system prompt
 * (not a step-by-step demo script). This module pulls in `@composio/core` (Node internals) and
 * the anthropic provider, so it MUST stay server-only — import it from route
 * handlers, never from a client component.
 *
 * Per-beat in-process tools (transaction reads for Beat 1, rule-setting for
 * Beat 3) are injected by the caller via `extraTools` so this factory stays
 * focused on assembly.
 */
import { anthropic } from "@ai-sdk/anthropic";
import {
  createVendoAgent,
  buildBrandGuidance,
  type ComposioClient,
} from "@vendoai/runtime";
import type { VendoAgent, ToolSummaryInput } from "@vendoai/core";
import {
  buildChatInstructions,
  capabilitySummary,
  novelComponentsSection,
} from "@vendoai/core";
import { prewiredComponents, brandToCssVars, componentPromptCatalog } from "@vendoai/components/descriptors";
import { mapleHostComponents } from "./host-components/descriptors";
import type { LanguageModel, ToolSet } from "ai";
import { demoPolicy } from "./policy";
import { mapleBrand } from "./brand";
import { demoAutomationInstructions } from "./automations";

/** Default model — fast + capable for a live, low-latency demo. Overridable. */
const DEMO_MODEL = process.env.VENDO_DEMO_MODEL ?? "claude-sonnet-4-6";

function componentCatalog(): string {
  return componentPromptCatalog(prewiredComponents);
}

/** The host app's registered components (source:'host') — data-driven from the
 *  registry, so newly registered components appear here automatically. */
function hostComponentCatalog(): string {
  return componentPromptCatalog(mapleHostComponents);
}

/** Maple's full system prompt — consumed by the demo agent factory below and
 *  by the @vendoai/next catch-all route (`instructions` option). Recomposed
 *  onto the shared prompt core (context-engineering spec §1): platform rules
 *  come from @vendoai/core sections; everything Maple-flavored stays HERE as
 *  host slots and extras. `toolSummary` (per-run, from the engine's
 *  InstructionContext) grounds the capability talk in the live toolset. */
export function buildInstructions(opts?: { toolSummary?: ToolSummaryInput[] }): string {
  const identity = [
    "You are Maple's assistant, an agent embedded in Maple (a consumer bank app). You can answer",
    "in plain text AND, when it helps, generate bespoke UI on demand via render_view.",
    "You are NOT limited to finance, and you never refuse by claiming a domain limit",
    "(e.g. 'I only do banking') — that is wrong.",
  ].join("\n");

  // Data-driven brand section: rendered from the SAME tokens the sandbox
  // injects (one source of truth), plus Maple's host-authored style norms.
  const brandGuidance = buildBrandGuidance({
    tokens: brandToCssVars(mapleBrand),
    norms: {
      density: "calm and generous — one idea per card, clear hierarchy, no cramming",
      tone: "quiet financial confidence; plain sentences, no exclamation marks, no hype",
      spacing: "roomy card padding (about 20px), 12-16px between rows, aligned numerals",
      charts: "restrained near-monochrome series, minimal gridlines, let the data speak",
    },
  });

  const catalogs = [
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
    componentCatalog(),
    "",
    "HOST COMPONENTS (source:'host') — the app's OWN components, pixel-identical to the",
    "product itself. When one fits, PREFER it over both catalog components and novel code",
    "(nothing is more on-brand than the host's real component). Reference by name with",
    "source:'host' and the exact props shown:",
    hostComponentCatalog(),
    "",
    "Prefer these prewired blocks. Compose them into whatever layout the request needs",
    "— side-by-side panels, a dashboard, a table, a chart, mixed components.",
    "- Images: only data:image URIs render (the sandbox blocks remote image loads); do NOT",
    "  use http/https image URLs — they will not load. Prefer components that don't need",
    "  remote images.",
    "",
    novelComponentsSection({ dispatchExample: "get_transactions" }),
  ].join("\n");

  const capabilities = [
    "Capabilities (reason about which fit the request; combine tools and UI as needed):",
    "- You can act through Maple's OWN API as the signed-in user: camelCase tools like",
    "  listAccounts, getAccount, listTransactions, listCards, listPayees, getBudgets,",
    "  and createOrder call the bank's real endpoints with the user's session. Reads run",
    "  freely; anything that moves money or changes state (like createOrder) pauses for",
    "  the user's explicit approval first — so don't refuse such requests, just call the",
    "  tool and let the approval card do the gating.",
    "- You can read the user's Maple transactions and turn them into whatever",
    "  visualization best answers the question — a table, a chart, or, when the question",
    "  is about WHEN money was spent, a time-of-day view that plots each charge by hour so",
    "  outliers stand out. Pick the component that makes the pattern obvious and call out",
    "  the most notable point.",
    "- You can investigate a specific charge by using the user's connected tools (such as",
    "  Gmail) to find the underlying receipt or confirmation, then render an itemized view",
    "  from the REAL details you find — and surface the meaningful detail (like the actual",
    "  order time), not just metadata.",
    "- You can set up standing AUTOMATIONS that fire on their own (see the AUTOMATIONS",
    "  section below). When you create one, do NOT perform its action (e.g. a Slack post)",
    "  yourself — the automation does that when it fires; just confirm it is active, in",
    "  plain language.",
    "- More broadly, for non-financial or open-ended requests, compose the blocks (and",
    "  novel components when needed) into the most useful bespoke interface you can.",
  ].join("\n");

  return buildChatInstructions({
    identity,
    brandGuidance,
    catalogs,
    capabilities,
    ...(opts?.toolSummary
      ? { toolSummary: capabilitySummary(opts.toolSummary, MAPLE_TOOLKITS) }
      : {}),
    toolkits: MAPLE_TOOLKITS,
    extras: [demoAutomationInstructions()],
  });
}

/** The demo's connectable toolkit catalog (drives connect guidance + the
 *  not-yet-connected list in the capability summary). */
const MAPLE_TOOLKITS = [
  "gmail", "slack", "notion", "github", "googlecalendar", "linear", "googledrive",
  "discord", "googlesheets", "stripe", "jira", "asana", "hubspot", "airtable",
];

export interface CreateDemoAgentOptions {
  /** Override the model (tests pass a mock). */
  model?: LanguageModel;
  /** Inject a Composio client (tests pass a stub; production builds the real one). */
  composioClient?: ComposioClient;
  /** Per-beat in-process tools (transaction reads, rule-setting). */
  extraTools?: ToolSet;
  /**
   * Composio toolkits to ingest. Driven by the demo connection store: the caller
   * passes the currently-connected toolkit ids. Defaults to [] (no external
   * tools) so an agent only gains a toolkit once the user connects it.
   */
  toolkits?: string[];
}

export function createDemoAgent(opts: CreateDemoAgentOptions = {}): VendoAgent {
  const model = opts.model ?? anthropic(DEMO_MODEL);
  return createVendoAgent({
    model,
    policy: demoPolicy,
    // Per-run assembly (spec §7): the capability summary needs the live merged
    // toolset, which only exists after Composio ingestion inside run().
    instructions: (ctx) => buildInstructions({ toolSummary: ctx.toolSummary }),
    composio: {
      // Only ingest toolkits the user has actually CONNECTED (the caller passes
      // the demo connection store's connected set). Requesting unconnected
      // toolkits makes Composio's fetch fail and the agent ends up with NO tools
      // at all, so an empty list is the correct fail-closed default.
      config: { toolkits: opts.toolkits ?? [] },
      client: opts.composioClient,
    },
    tools: opts.extraTools,
    maxSteps: 10,
    components: [...prewiredComponents, ...mapleHostComponents],
  });
}
