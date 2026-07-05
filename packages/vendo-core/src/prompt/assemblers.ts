/**
 * The two prompt assemblers (context-engineering spec §1). Guarded order:
 * platform sections → typed host slots → free-form host extras →
 * guardrailSection LAST — host content never gets recency over the
 * non-negotiables, and the contract is explicit: platform rules win.
 *
 * Everything host- or package-owned (identity, brand guidance, component
 * catalogs, capability narratives, tool summaries) arrives as pre-rendered
 * strings; this module stays pure.
 */
import {
  capabilitiesSection,
  connectSection,
  consentSection,
  genuiFormatSection,
  guardrailSection,
  proactivitySection,
  refreshableViewsSection,
  registerSection,
  showVsSaySection,
  styleSection,
} from "./sections.js";

export interface ChatInstructionsInput {
  /** Host identity block ("You are <product>'s assistant…"). */
  identity: string;
  /** Pre-rendered brand guidance (runtime's buildBrandGuidance output). */
  brandGuidance?: string;
  /** Pre-rendered component catalogs (building blocks + catalog + host components). */
  catalogs?: string;
  /** Host capability narrative (what the product wants emphasized). */
  capabilities?: string;
  /** Generated live-toolset digest (capability-summary.ts). */
  toolSummary?: string;
  /** Connectable toolkit ids for the connect protocol text. */
  toolkits?: string[];
  /** Style norms (host-driven). */
  norms?: { noEmoji?: boolean; extra?: string[] };
  /** Free-form host blocks, appended before the guardrails. */
  extras?: string[];
}

export function buildChatInstructions(input: ChatInstructionsInput): string {
  const sections = [
    input.identity,
    showVsSaySection("chat"),
    styleSection(input.norms ?? { noEmoji: true }),
    input.brandGuidance,
    genuiFormatSection(),
    refreshableViewsSection("chat"),
    input.catalogs,
    input.capabilities,
    capabilitiesSection("chat", input.toolSummary),
    // Connect guidance only makes sense when integrations exist at all.
    input.toolkits ? connectSection("chat", { toolkits: input.toolkits }) : undefined,
    consentSection("chat"),
    registerSection("chat"),
    proactivitySection("chat"),
    ...(input.extras ?? []),
    guardrailSection("chat"),
  ];
  return sections.filter((s): s is string => Boolean(s && s.trim())).join("\n\n");
}

export interface VoiceInstructionsInput {
  /** Host persona line(s) ("You are <product>'s voice assistant — …"). */
  persona: string;
  /** Generated live-toolset digest (capability-summary.ts). */
  toolSummary?: string;
  /** Free-form host blocks (domain conventions etc.), before the guardrails. */
  extras?: string[];
}

export function buildVoiceInstructions(input: VoiceInstructionsInput): string {
  const sections = [
    input.persona,
    registerSection("voice"),
    showVsSaySection("voice"),
    refreshableViewsSection("voice"),
    connectSection("voice"),
    consentSection("voice"),
    capabilitiesSection("voice", input.toolSummary),
    proactivitySection("voice"),
    ...(input.extras ?? []),
    guardrailSection("voice"),
  ];
  return sections.filter((s): s is string => Boolean(s && s.trim())).join("\n\n");
}
