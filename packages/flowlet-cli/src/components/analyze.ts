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
  // PascalCase is only enforced at codegen time (writeComponent) — an
  // include:false reply may carry any placeholder (or empty) name and must
  // still validate.
  name: z.string(),
  description: z.string(),
  /** Named exports to import from the host file (e.g. ["Button"]). */
  imports: z.array(z.string()),
  props: z.array(propSpecSchema),
  /** A single JSX expression using `p` (parsed props) and the imported names. */
  jsx: z.string(),
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
