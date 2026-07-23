import { staticFacts, type StaticTool } from "./stages.js";

/**
 * The delegated-extraction contract (install-dx: external-agent delegation).
 * Vendo's IP is the CONTRACT — the composed instructions, the draft schema,
 * and the deterministic guards — not the reader: any competent coding agent
 * (Claude Code, Cursor, Codex, …) can do the reading. `vendo init --agent`
 * emits this contract in its plan; the dev's own agent reads the codebase,
 * writes a draft, and `vendo extract --apply` runs it through the SAME
 * applyDraft guards as init's built-in pass — delegation never becomes a
 * second, weaker path into `.vendo/`.
 */

export const APPLY_COMMAND = "npx vendo extract --apply <draft.json>";

/** JSON Schema mirror of extractionDraftSchema in harness.ts (hand-kept in
 *  sync — zod v3 has no schema emitter). Stricter than parseDraft on unknown
 *  keys, deliberately: the contract steers agents to the exact shape while
 *  apply stays lenient. */
export const EXTRACTION_DRAFT_JSON_SCHEMA: Record<string, unknown> = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["brief", "tools"],
  properties: {
    brief: {
      type: "string",
      minLength: 1,
      maxLength: 4000,
      description: "One-paragraph product brief drafted from the codebase.",
    },
    tools: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "description"],
        properties: {
          name: { type: "string", minLength: 1 },
          description: { type: "string", minLength: 1, maxLength: 500 },
          risk: { enum: ["read", "write", "destructive"] },
          critical: { type: "boolean" },
          disabled: {
            type: "boolean",
            description: "false = wake a statically-unclassifiable tool (requires reasoning and risk).",
          },
          audience: {
            enum: ["end-user", "operator", "internal"],
            description: "Who the handler's own auth admits; non-end-user grades exclude the tool by default.",
          },
          reasoning: { type: "string", maxLength: 500 },
        },
      },
    },
    missedSurfaces: {
      type: "array",
      items: { type: "string", maxLength: 300 },
      description: "API surfaces the static extractor missed (path + one line). Surfaced to the dev, never written.",
    },
  },
};

/** One-shot instructions for an external agent producing the FULL draft
 *  (judgment on every tool plus the brief) — the same rules the staged
 *  pipeline enforces per stage, phrased for a single delegated pass. */
export function composeDelegatedInstructions(tools: StaticTool[], appName: string): string {
  return [
    "You are Vendo's extraction agent. Read this codebase (Read/Glob/Grep only) and draft",
    "judgment on the API tools a static extractor already found, plus the product brief.",
    "",
    `Product/package name: ${appName}`,
    "Statically extracted tools (name, method+path when known, current risk, disabled state):",
    staticFacts(tools),
    "",
    "Rules:",
    "- Produce ONE json document matching the provided draftSchema:",
    '  { "brief": string, "tools": [{ "name", "description", "risk"?, "critical"?, "disabled"?, "audience"?, "reasoning"? }], "missedSurfaces"?: string[] }',
    "- tools: include ONLY names from the list above. Rewrite each description so an agent choosing tools understands what it actually does (read the handler source). <= 200 chars each.",
    "- risk: you may RAISE risk (read->write->destructive) when the handler is more dangerous than labeled; never lower it. Mark irreversible operations critical: true.",
    "- A tool listed as disabled was statically unclassifiable. If you can read its handler and grade it, set disabled: false WITH a risk and one-line reasoning. Leave it out otherwise.",
    "- audience: who the handler's own auth admits — \"end-user\" (a signed-in customer acting on their own data),",
    "  \"operator\" (admin/staff/support consoles), or \"internal\" (machine-to-machine: webhooks, cron, reconciliation,",
    "  service tokens). Read the auth checks, not the route name. When unsure, default to internal — non-end-user",
    "  tools are excluded from the embedded agent by default, and a wrong \"end-user\" grade exposes a privileged surface.",
    "- missedSurfaces: API surfaces you found that the list is missing (path + one line). Do not invent tools for them.",
    "- brief: one paragraph — what the product does, who uses it, the jobs the agent should help with. Written from the actual code, no marketing fluff.",
    `- Save the draft to a json file and apply it with \`${APPLY_COMMAND}\` — deterministic guards validate every entry before anything lands in .vendo/.`,
  ].join("\n");
}
