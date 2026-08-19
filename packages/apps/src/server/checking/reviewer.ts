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
  type AppDocument,
} from "../../contract/index.js";
// The screen engine, by its own path: the contract door does not carry it yet.
import { SCREEN_FILE } from "../../contract/genui/component/index.js";
import type { FloorDependencies } from "./deps.js";
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
 *  exactly the {@link Finding} shape.
 *
 *  THE VERDICT IS WRITTEN LAST. Property order here is the order the model writes
 *  in — the object goes to `input_schema` by reference and JSON keeps insertion
 *  order — so `where` and `message` come before `severity`: naming the locus and
 *  the evidence first means the grade is chosen against a written-out fact rather
 *  than the fact being written to justify a grade already picked. */
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
        required: ["where", "message", "severity"],
        properties: {
          where: {
            type: "string",
            description: 'The locus: the component and its label, the query name, or "document".',
          },
          message: {
            type: "string",
            description: "One sentence: what the screen does, and the evidence for it.",
          },
          severity: {
            type: "string",
            enum: ["block", "warn"],
            // "everything else" read as a leftovers bin next to two named
            // headline sins, and a broken house rule fell out of it. It is named
            // here because a tool description is prompt, arriving in the same call.
            description:
              "block for dishonesty and invented data; warn for everything else, a broken house rule included.",
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

/** The app as the reviewer reads it: the screen's own `app.tsx`, exactly as the
 *  row stores it. Undefined when the document carries no screen — the `document`
 *  fact check reports that, and the reviewer stays quiet instead of judging
 *  rubble. */
const storedScreen = (app: AppDocument): string | undefined => {
  const text = app.source?.[SCREEN_FILE]?.text;
  return typeof text === "string" && text.trim() !== "" ? text : undefined;
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
   * The caller that holds the source AND the query results builds it
   * (`reviewComponentScreenInput`). Absent, the STORED screen is read instead.
   */
  app?: string,
): Check => ({
  name: REVIEWER_CHECK_NAME,
  // `fact` is about WHO RUNS IT, not about how sure it is: the two kinds are
  // "code the floor runs" and "a sentence for the reviewer's rubric" (core
  // `pack.ts`). The reviewer is code, and it is the thing rubric lines are
  // handed to — it can hardly be one of them.
  kind: "fact",
  run: async ({ document, request }): Promise<Finding[]> => {
    const screen = app ?? storedScreen(document);
    if (screen === undefined) return [];
    // A caller's own rendering arrives already labelled and with its data already
    // beside it, so it takes neither the header nor a second data block.
    const body = app === undefined
      ? `APP (app.tsx):\n${screen}${samples === undefined ? "" : sampleLines(samples)}`
      : app;
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
