/**
 * The AI reviewer (generation pipeline rebuild, Task 6): a checking-layer
 * {@link Check} that spends ONE strict tool call judging what no lookup can —
 * invented data, dishonest tool use, dead controls, sections that miss the ask.
 *
 * Its findings are advice like every other check's. Silence, a refusal to call
 * the tool, and a failed request all mean "no findings": a reviewer must never
 * be the reason a generated app dies (the layer guards a throw too, but this
 * one does not throw in the first place).
 */
import { printWire } from "@vendoai/core";
import { treeOf } from "./facts.js";
import type { Check, Finding } from "./types.js";
import { REPORT_FINDINGS_DESCRIPTION, REVIEWER_SYSTEM } from "../generation/prompts/reviewer.js";
import { strictToolCall } from "../generation/stages/repair.js";
import type { GeneratedAppDocument, GenerationDependencies } from "../generation/engine.js";

export const REVIEWER_CHECK_NAME = "reviewer";

const REPORT_FINDINGS_TOOL = "report_findings";

/** One query result trimmed to this many characters of JSON — enough to judge
 *  a literal against, small enough that a long table cannot crowd the app
 *  markup out of the prompt. */
const MAX_SAMPLE_CHARS = 800;

/** The flat strict schema (Anthropic strict tool use: additionalProperties
 *  false, every property required, no recursion) — one array of findings in
 *  exactly the {@link Finding} shape. */
const REPORT_FINDINGS_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      description: "Everything wrong with the app; empty when nothing is.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "where", "message"],
        properties: {
          severity: {
            type: "string",
            enum: ["block", "warn"],
            description: "block for dishonesty and invented data; warn for everything else.",
          },
          where: {
            type: "string",
            description: 'The locus: the component and its label, the query name, or "document".',
          },
          message: {
            type: "string",
            description: "One sentence: what is wrong AND the real alternative.",
          },
        },
      },
    },
  },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The reported findings, keeping only entries that really are {@link Finding}s
 *  — a malformed entry is dropped, never coerced and never thrown. */
const findingsFrom = (reported: unknown): Finding[] => {
  if (!Array.isArray(reported)) return [];
  return reported.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const { severity, where, message } = entry;
    if (severity !== "block" && severity !== "warn") return [];
    if (typeof where !== "string" || typeof message !== "string") return [];
    return [{ severity, where, message }];
  });
};

/** The app as the reviewer reads it: id-free wire markup, so it judges what a
 *  person sees rather than compiler bookkeeping. Undefined when the document
 *  carries no valid tree — the `document` fact check reports that, and the
 *  reviewer stays quiet instead of judging rubble. */
const printedApp = (app: GeneratedAppDocument): string | undefined => {
  const tree = treeOf(app);
  if (tree === undefined) return undefined;
  return printWire(
    { tree, components: app.components ?? {}, name: app.name },
    { includeIds: false },
  );
};

const sampleLines = (samples: Readonly<Record<string, unknown>>): string => {
  const lines = Object.entries(samples).map(([query, value]) => {
    const text = JSON.stringify(value) ?? "null";
    return `${query}: ${text.length > MAX_SAMPLE_CHARS ? `${text.slice(0, MAX_SAMPLE_CHARS)}…` : text}`;
  });
  return lines.length === 0 ? "" : `\nRESOLVED_DATA (what this app's queries actually returned):\n${lines.join("\n")}`;
};

/**
 * The reviewer, bound to the model it calls with and (when generation resolved
 * them) the query results the app's literals must match.
 */
export const reviewerCheck = (
  deps: GenerationDependencies,
  samples?: Readonly<Record<string, unknown>>,
): Check => ({
  name: REVIEWER_CHECK_NAME,
  run: async ({ app, request }): Promise<Finding[]> => {
    const printed = printedApp(app);
    if (printed === undefined) return [];
    const reported = await strictToolCall(
      deps,
      REPORT_FINDINGS_TOOL,
      REPORT_FINDINGS_DESCRIPTION,
      REPORT_FINDINGS_SCHEMA,
      REVIEWER_SYSTEM,
      `USER_REQUEST: ${request}\nAPP (wire markup):\n${printed}${samples === undefined ? "" : sampleLines(samples)}`,
    );
    return reported === undefined ? [] : findingsFrom(reported.findings);
  },
});
