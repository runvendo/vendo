/**
 * The AI reviewer (generation pipeline rebuild, Task 6): a checking-layer
 * {@link Check} that spends ONE strict tool call judging what no lookup can —
 * invented data, dishonest tool use, dead controls, sections that miss the ask.
 *
 * A `block` it reports stops the app being written, like any other check's.
 * That cuts one way only: silence, a refusal to call the tool, and a failed
 * request all mean "no findings" — a reviewer that could not judge must never
 * be the reason a good app dies (the layer guards a throw too, but this one
 * does not throw in the first place).
 */
import {
  componentSources,
  printWire,
  type AppDocument,
  type AppPlan,
} from "../../contract/index.js";
import type { FloorDependencies } from "./deps.js";
import { treeOf } from "./facts.js";
import { REPORT_FINDINGS_DESCRIPTION, REVIEWER_SYSTEM } from "./reviewer-prompt.js";
import { strictToolCall } from "./strict-tool-call.js";
import type { Check, Finding } from "./types.js";

export const REVIEWER_CHECK_NAME = "reviewer";

const REPORT_FINDINGS_TOOL = "report_findings";

/** One query result trimmed to this many characters of JSON — enough to judge
 *  a literal against, small enough that a long table cannot crowd the app
 *  markup out of the prompt.
 *
 *  Raised from 800 when the reviewer started judging AGGREGATES rather than only
 *  literals: 800 characters is three or four rows, and a total cannot be checked
 *  against three rows. A trailing `…` is what says the rest was cut, and the
 *  rubric tells the reviewer how to reason when it sees one. */
const MAX_SAMPLE_CHARS = 4_000;

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
const printedApp = (app: AppDocument): string | undefined => {
  const tree = treeOf(app);
  if (tree === undefined) return undefined;
  return printWire(
    { tree, components: componentSources(app.components), name: app.name },
    { includeIds: false },
  );
};

/**
 * What the PLAN committed to that the app's markup cannot show.
 *
 * Away-from-the-browser work is the load-bearing case: an automation is armed by
 * the runtime's server lane AFTER this review runs, so a reviewer reading only
 * the tree sees no reminder and concludes the ask was dropped. It was not — it
 * simply does not live in the markup. Telling it what was planned is the
 * difference between a true finding and a false accusation on every scheduled app.
 */
const planLines = (plan: AppPlan | undefined): string => {
  if (plan === undefined) return "";
  const lines: string[] = [];
  if (plan.server !== undefined) {
    const { kind, schedule, why, served } = plan.server;
    lines.push(`- server work IS planned and the runtime arms it after this review: kind="${kind}"${schedule === undefined ? "" : ` schedule="${schedule}"`}${served === true ? " (it serves the whole app surface)" : ""} — ${why}`);
  }
  for (const cannot of plan.cannot) {
    lines.push(`- the host cannot do this, and the person was told so verbatim: ${cannot}`);
  }
  return lines.length === 0
    ? ""
    : `\nALREADY PLANNED (do NOT report these as missing — they are committed, and some of them land after you read this):\n${lines.join("\n")}`;
};

/** The resolved data block, exported because the COMPONENT screen's reviewer
 *  input needs the same truncation discipline (checking/component-screen.ts) and
 *  a second copy of the cap would drift from this one. */
export const sampleLines = (samples: Readonly<Record<string, unknown>>): string => {
  const lines = Object.entries(samples).map(([query, value]) => {
    const text = JSON.stringify(value) ?? "null";
    return `${query}: ${text.length > MAX_SAMPLE_CHARS ? `${text.slice(0, MAX_SAMPLE_CHARS)}…` : text}`;
  });
  return lines.length === 0 ? "" : `\nRESOLVED_DATA (what this app's queries actually returned):\n${lines.join("\n")}`;
};

/**
 * Every plugged judgment rule, appended to the rubric as its own line.
 *
 * One line per rule, never concatenated: a joined blob reads as a single garbled
 * rule. They are appended rather than woven in, so a host rule can add a reason
 * to reject but can never soften the five the reviewer already applies.
 */
const rubricSection = (rubric: readonly string[]): string => (rubric.length === 0 ? "" : `

ALSO REJECT anything that breaks one of these rules, which this product's owner set. Judge them exactly like the five above, and quote the rule you applied in your message:
${rubric.map((rule) => `- ${rule}`).join("\n")}`);

/**
 * The reviewer, bound to the model it calls with, (when generation resolved them)
 * the query results the app's literals must match, and the judgment rules the
 * floor collected from the host and every pack.
 */
export const reviewerCheck = (
  deps: FloorDependencies,
  samples?: Readonly<Record<string, unknown>>,
  rubric: readonly string[] = [],
  /**
   * The app as the reviewer should READ it, when the caller has a truer rendering
   * than printed wire.
   *
   * A COMPONENT screen is the case: its app is one `.tsx` file, so there is nothing
   * to print — the file the model wrote is the file the reviewer reads
   * (`reviewComponentScreenInput`, which the caller builds because it is the half
   * that holds the source and the query results). Absent, the document is printed
   * as wire exactly as it always was.
   */
  app?: string,
): Check => ({
  name: REVIEWER_CHECK_NAME,
  // `fact` is about WHO RUNS IT, not about how sure it is: the two kinds are
  // "code the floor runs" and "a sentence for the reviewer's rubric" (core
  // `pack.ts`). The reviewer is code, and it is the thing rubric lines are
  // handed to — it can hardly be one of them.
  kind: "fact",
  run: async ({ document, request, plan }): Promise<Finding[]> => {
    const printed = app ?? printedApp(document);
    if (printed === undefined) return [];
    // A caller's own rendering arrives already labelled and with its data already
    // beside it, so it takes neither the wire header nor a second data block.
    const body = app === undefined
      ? `APP (wire markup):\n${printed}${planLines(plan)}${samples === undefined ? "" : sampleLines(samples)}`
      : `${app}${planLines(plan)}`;
    const reported = await strictToolCall(
      // The one model call the floor spends rides the REVIEW seat when the
      // deployment composed one — spread over `model` rather than read inside
      // `strictToolCall`, so the caller that owns the seat is the one that
      // chooses it and every other strict call is untouched.
      deps.reviewModel === undefined ? deps : { ...deps, model: deps.reviewModel },
      REPORT_FINDINGS_TOOL,
      REPORT_FINDINGS_DESCRIPTION,
      REPORT_FINDINGS_SCHEMA,
      `${REVIEWER_SYSTEM}${rubricSection(rubric)}`,
      `USER_REQUEST: ${request}\n${body}`,
    );
    return reported === undefined ? [] : findingsFrom(reported.findings);
  },
});
