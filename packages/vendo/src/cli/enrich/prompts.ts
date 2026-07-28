import type { ExtractedTool, OverridesFile } from "@vendoai/actions";
import type { EnrichmentDiff } from "./diff.js";

/**
 * ALL prompt content for the sync AI-enrichment pass lives HERE (cse lane 1c
 * boundary rule: one module, clear constants). The engine composes these
 * instructions; the extract harness seam (Read/Glob/Grep only) executes them;
 * the deterministic clamp in @vendoai/actions decides what applies. Nothing
 * the model says can loosen a tool — the rules below tell it so, and the
 * clamp enforces it regardless.
 */

export const ENRICHMENT_OUTPUT_RULES = [
  "Rules:",
  "- Reply with ONLY one fenced json block matching:",
  '  { "tools": [{ "name", "title"?, "description"?, "risk"?, "critical"?, "disabled"?, "audience"?, "semantics"?, "reasoning"? }], "narrative": string }',
  "- tools: include ONLY names from the catalog above. You may not add, rename, or rebind tools;",
  "  bindings and input schemas are machine-owned and ignored if you send them.",
  "- description: rewrite so an agent choosing tools understands what the handler actually does",
  "  (read the source). <= 300 chars.",
  '- title: the short human label a PERSON sees for this tool in an MCP client\'s menu or an',
  '  approval card — imperative, sentence case, no tool name, no punctuation ("Send payment",',
  '  "List recent transactions"). <= 60 chars. Describe only what the tool actually does; a',
  "  title that promises more than the handler delivers is a lie, not a label. Write one for",
  "  every tool you touch.",
  "- risk: you may RAISE risk (read->write->destructive) when the handler is more dangerous than",
  "  labeled; you can never lower it — a lower grade is ignored. Mark irreversible operations",
  "  critical: true.",
  "- disabled: you may set disabled: true for tools that should not reach the embedded agent.",
  "  You can never enable a disabled tool; enabling is a human edit in .vendo/overrides.json.",
  '- audience: who the handler\'s own auth admits — "end-user" (a signed-in customer acting on',
  '  their own data), "operator" (admin/staff consoles), or "internal" (machine-to-machine:',
  "  webhooks, cron, service tokens). Read the auth checks, not the route name. You may only",
  "  narrow (end-user -> operator -> internal); a non-end-user grade disables the tool by default.",
  '- semantics: response-field meanings keyed by collapsed dot path (arrays collapse:',
  '  "data.amountCents"), each one of: { "kind": "money", "unit": "cents"|"dollars", "currency"? }',
  '  | { "kind": "date", "format": "iso"|"epoch" } | { "kind": "enum", "labels": {value: label} }',
  '  | { "kind": "id", "entity"? } | { "kind": "percent", "scale": "ratio"|"0-100" } |',
  '  { "kind": "plain" }. Only include fields you read evidence for in the handler code/types.',
  "- narrative: a short human-readable story of what changed and what you updated — new tools,",
  "  reclassified tools, anything suspicious. Plain prose, <= 30 lines.",
].join("\n");

/** The per-tool catalog projection the model reasons over — judgment fields
 *  only, never the machine skeleton (schemas stay on disk where the model can
 *  read them if it needs to). */
export function catalogFacts(tools: ExtractedTool[]): string {
  return JSON.stringify(tools.map((tool) => ({
    name: tool.name,
    binding: `${tool.binding.kind}${"method" in tool.binding && "path" in tool.binding ? ` ${String(tool.binding.method)} ${String(tool.binding.path)}` : ""}`,
    risk: tool.risk,
    ...(tool.critical === true ? { critical: true } : {}),
    ...(tool.disabled === true ? { disabled: true } : {}),
    ...(tool.audience === undefined ? {} : { audience: tool.audience }),
    ...(tool.enriched === true ? { enriched: true } : {}),
    ...(tool.title === undefined ? {} : { title: tool.title }),
    description: tool.description,
  })), null, 2);
}

export interface EnrichmentPromptInput {
  appName: string;
  diff: EnrichmentDiff;
  tools: ExtractedTool[];
  overrides: OverridesFile | null;
  candidates: { added: string[]; changed: string[]; unenriched: string[] };
}

export function composeEnrichmentInstructions(input: EnrichmentPromptInput): string {
  const overrideNames = Object.keys(input.overrides?.tools ?? {}).sort();
  const affected = [...new Set([...input.candidates.added, ...input.candidates.changed, ...input.candidates.unenriched])].sort();
  return [
    "You are Vendo's sync enrichment agent. A deterministic scanner already extracted this",
    "product's API tools into the catalog below; your pass adds judgment the scanner cannot:",
    "real descriptions, risk/audience corrections, response-field semantics. Read the codebase",
    "(Read/Glob/Grep only) wherever the diff or the catalog leaves you unsure.",
    "",
    `Product/package name: ${input.appName}`,
    "",
    ...(input.diff.mode === "diff"
      ? [
        "Code changes since the last enrichment (git diff; uncommitted edits included):",
        "```diff",
        input.diff.patch.trimEnd(),
        "```",
        "",
        "Update every tool AFFECTED by this diff — directly (its handler changed) or indirectly",
        "(a shared helper/type it uses changed its meaning). Mention each affected tool in",
        "`tools` even if only to confirm its current entry; unaffected tools may be omitted.",
      ]
      : [
        "This is a FULL-REPO pass (no reliable incremental diff): review every tool in the",
        "catalog and return judgment for each one you can improve.",
      ]),
    "",
    "Current tool catalog (.vendo/tools.json — judgment fields only):",
    catalogFacts(input.tools),
    "",
    ...(affected.length > 0 ? [
      "Tools the scanner flagged for this pass (new, source-changed, or never enriched):",
      JSON.stringify(affected, null, 2),
      "",
    ] : []),
    ...(overrideNames.length > 0 ? [
      "Read-only context — tools with HUMAN overrides in .vendo/overrides.json (their overrides",
      "always win over anything you write; do not restate them):",
      JSON.stringify(overrideNames, null, 2),
      "",
    ] : []),
    ENRICHMENT_OUTPUT_RULES,
  ].join("\n");
}

export function composeTripwireInstructions(input: {
  appName: string;
  tool: ExtractedTool;
}): string {
  return [
    "You are Vendo's sync enrichment agent on a targeted re-read: this ONE tool's handler",
    "source changed since its last enrichment and the main pass did not account for it.",
    "Find and read the handler in this codebase (Read/Glob/Grep only), then return updated",
    "judgment for exactly this tool.",
    "",
    `Product/package name: ${input.appName}`,
    "The tool (current entry):",
    catalogFacts([input.tool]),
    "",
    ENRICHMENT_OUTPUT_RULES,
  ].join("\n");
}
