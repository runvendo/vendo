import { z } from "zod";
import type { LanguageModel } from "ai";
import { generateJson } from "../llm.js";
import type { ComponentCandidate } from "./scan.js";

export const propSpecSchema = z.object({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/),
  type: z.enum(["string", "number", "boolean", "string[]", "number[]", "enum"]),
  enumValues: z.array(z.string()).optional(),
  optional: z.boolean(),
  description: z.string().min(1),
});

export const componentAnalysisSchema = z.object({
  include: z.boolean(),
  reason: z.string(),
  // Everything below only matters when include=true (enforced at codegen time
  // in writeComponent) — a minimal include:false reply may omit all of it.
  name: z.string().default(""),
  description: z.string().default(""),
  /** Named exports to import from the host file (e.g. ["Button"]). */
  imports: z.array(z.string()).default([]),
  props: z.array(propSpecSchema).default([]),
  /** A single JSX expression using `p` (parsed props) and the imported names. */
  jsx: z.string().default(""),
});
export type ComponentAnalysis = z.infer<typeof componentAnalysisSchema>;

function buildPrompt(c: ComponentCandidate, feedback?: string): string {
  const feedbackBlock = feedback
    ? ["", "Your previous wrapper spec for this component failed:", feedback, "Fix the problem and respond again.", ""]
    : [];
  return [
    "You are wrapping a host React component so a sandboxed generated-UI runtime can render it.",
    "The sandbox renders components from JSON props only. Decide whether this component is a",
    "reusable presentational primitive worth exposing, and if so emit its wrapper spec.",
    "",
    "Hard rules:",
    "- include=false for pages, layouts, providers, portals/toasts, or components needing",
    "  callbacks, context, refs, ReactNode props, or data fetching to be useful.",
    "- props: JSON-serializable only (string/number/boolean/arrays/enum). Map ReactNode-ish",
    '  slots to strings (e.g. children -> a "text" string prop).',
    "- description: 1-2 sentences that help a language model decide when to pick this component.",
    "- jsx: ONE JSX expression using `p` for parsed props and ONLY the names in `imports`.",
    "  No hooks, no window/document, no new dependencies, no event handlers.",
    "",
    "Respond with ONLY JSON:",
    '{"include":bool,"reason":"...","name":"PascalCase","description":"...",',
    ' "imports":["..."],"props":[{"name":"...","type":"string","optional":false,"description":"..."}],',
    ' "jsx":"<Button variant={p.variant}>{p.label}</Button>"}',
    ...feedbackBlock,
    "",
    `--- ${c.relFile} ---`,
    c.source,
  ].join("\n");
}

export async function analyzeComponent(
  c: ComponentCandidate,
  model: LanguageModel,
  feedback?: string,
): Promise<ComponentAnalysis> {
  return generateJson({ model, schema: componentAnalysisSchema, prompt: buildPrompt(c, feedback) });
}

// ---- proposal (catalog picker) ---------------------------------------------
// The picker needs a name + one-line reason per candidate. Rather than run the
// full (per-component) analyze pass just to obtain reasons — which would then
// have to run AGAIN at generation time — the proposal is ONE batch LLM call
// over all scanned candidates. Only the components the user then picks pay for
// a full analyze+write. See extractComponents for the propose→select→generate
// split.

export const componentProposalSchema = z.object({
  proposals: z.array(
    z.object({
      /** The candidate's relFile, echoed back so we can map the reply to a candidate. */
      file: z.string(),
      wrappable: z.boolean(),
      /** One line shown next to the checkbox (why it's proposed, or why not). */
      reason: z.string().min(1),
    }),
  ),
});
export type ComponentProposals = z.infer<typeof componentProposalSchema>;

export interface ProposedComponent {
  candidate: ComponentCandidate;
  /** The one-line reason to show as the picker hint. */
  reason: string;
}

export interface ComponentProposalResult {
  /** Candidates worth wrapping — the checkbox picker's (pre-checked) items. */
  wrappable: ProposedComponent[];
  /** Candidates the model judged not worth wrapping (reported, never shown). */
  excluded: Array<{ file: string; reason: string }>;
}

/** Keep the batch prompt bounded: a per-file source snippet, not the whole file. */
const PROPOSAL_SNIPPET_BYTES = 1200;

function buildProposalPrompt(candidates: ComponentCandidate[]): string {
  const blocks = candidates.map((c) => {
    const snippet =
      c.source.length > PROPOSAL_SNIPPET_BYTES
        ? `${c.source.slice(0, PROPOSAL_SNIPPET_BYTES)}\n… (truncated)`
        : c.source;
    return [`--- ${c.relFile} (exports: ${c.exportNames.join(", ")}) ---`, snippet].join("\n");
  });
  return [
    "You are curating which host React components to expose to a sandboxed generated-UI runtime.",
    "The sandbox renders components from JSON props only. For EACH file below decide whether it is a",
    "reusable presentational primitive worth wrapping, and give a ONE-LINE reason a developer will read",
    "next to a checkbox in a picker.",
    "",
    "wrappable=false for pages, layouts, providers, portals/toasts, or components that need callbacks,",
    "context, refs, ReactNode props, or data fetching to be useful. wrappable=true for stateless visual",
    "primitives (buttons, badges, cards, inputs, alerts, …).",
    "",
    "Respond with ONLY JSON. Echo each file path back exactly as it appears in the header:",
    '{"proposals":[{"file":"<path>","wrappable":true,"reason":"one short line"}]}',
    "",
    ...blocks,
  ].join("\n");
}

/**
 * A single batch LLM call that annotates every scanned candidate with a
 * wrappable flag + one-line reason. Candidates absent from the reply default to
 * wrappable (a model that forgets a file must not silently drop it from the
 * catalog — the user can still uncheck it).
 */
export async function proposeComponents(
  candidates: ComponentCandidate[],
  model: LanguageModel,
): Promise<ComponentProposalResult> {
  const { proposals } = await generateJson({
    model,
    schema: componentProposalSchema,
    prompt: buildProposalPrompt(candidates),
  });
  const byFile = new Map(proposals.map((p) => [p.file, p]));
  const wrappable: ProposedComponent[] = [];
  const excluded: Array<{ file: string; reason: string }> = [];
  for (const candidate of candidates) {
    const p = byFile.get(candidate.relFile);
    if (p && !p.wrappable) {
      excluded.push({ file: candidate.relFile, reason: p.reason });
      continue;
    }
    wrappable.push({ candidate, reason: p?.reason ?? "component primitive" });
  }
  return { wrappable, excluded };
}
