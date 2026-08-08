import { createAnthropic } from "@ai-sdk/anthropic";
import { generateObject, jsonSchema, type LanguageModel } from "ai";
import { createHash } from "node:crypto";
import type { Probed } from "./probe.js";

/**
 * The non-mechanical half of the score.
 *
 * The floor answers what a machine can settle alone — did it render, are the
 * numbers real, do the buttons fire. This answers the rest, one rubric line at
 * a time: the case's `pass` lines (did it do what was asked) and the world's
 * `style` lines (does it look like the product it claims to be).
 *
 * It grades blind. Nothing it is sent names the contender, its model or its
 * run folder, and the lines arrive shuffled, so a judge cannot learn an order
 * or reward a name. The one leak left is the artifact's own format — a tree
 * and a hand-written document do not look alike — and it is disclosed rather
 * than papered over, because stripping it would destroy the evidence.
 */

export const VERDICTS = ["pass", "fail", "na"] as const;
export type Verdict = (typeof VERDICTS)[number];
export type LineSource = "case" | "style";

export interface LineVerdict {
  readonly line: string;
  readonly source: LineSource;
  readonly verdict: Verdict;
  /** One clause naming the evidence, in the judge's own words. */
  readonly note: string;
}

export interface JudgeResult {
  /** Every line, in the order it was given — case lines then style lines. */
  readonly lines: readonly LineVerdict[];
  /** The judge could not be trusted, so every line was failed rather than guessed. */
  readonly degraded: boolean;
  readonly error?: string;
}

export interface JudgeInput {
  readonly screenshot: Buffer;
  readonly artifact: string;
  readonly trace: readonly Probed[];
  readonly caseLines: readonly string[];
  readonly styleLines: readonly string[];
}

export interface JudgeOptions {
  /** Defaults to the contract's pinned model. Tests pass a double here; the
   *  run never does, which is what keeps the judge model off the contender. */
  readonly model?: LanguageModel;
  readonly delayMs?: (attempt: number) => number;
}

/**
 * rubricVersion bumps on ANY edit; founder sign-off required before results count.
 */
export const SYSTEM_PROMPT = `You are grading one screen of a software product against a fixed checklist. You are not its designer, its author, or a reviewer offering advice: you decide, line by line, what the evidence supports.

THE EVIDENCE, in priority order. Where two sources disagree, the earlier one wins.
1. THE SCREENSHOT — the screen exactly as a person sees it. This is what the user actually gets.
2. THE INTERACTION TRACE — every control on the screen was pressed once, and this records what each press asked the application to do. This is what actually happened when the screen was used.
3. THE SOURCE — what the screen was built from. This is only what was intended. The source may be written in any format, and its format is not evidence: it must never affect a verdict. A line the source promises but the screenshot does not show is not satisfied.

Return exactly one verdict for each numbered checklist line, in the order the lines are numbered — no more, no fewer.
- pass: the evidence clearly shows this line is satisfied.
- fail: the evidence clearly shows this line is violated, OR the line applies to this screen and the evidence does not show it satisfied. Not demonstrated is not a pass.
- na: the line's subject does not occur on this screen at all, so there is nothing here to satisfy or violate — for example, a line about confirming destructive actions on a screen that only displays information. Use na only for an absent subject, never for your own uncertainty: when the subject is present and you are unsure, the verdict is fail.

Every verdict carries a note: one clause naming the specific evidence you used, such as "the header reads Spending" or "pressing Cancel called nothing". No advice, no praise, no summary, and no restating the line back.

Grade only the numbered lines. Anything else you notice about this screen, good or bad, is not yours to grade: it must not change a verdict and must not appear in a note. Judge the screen you were given, not the screen you would have built.`;

/** The judge's own model, written here and nowhere else. It is deliberately NOT
 *  read from the run's model table: the grader must not move when the graded
 *  contender does, or two columns stop being comparable. */
export const JudgeContract = {
  model: "claude-opus-5",
  rubricVersion: 1,
  promptHash: createHash("sha256").update(SYSTEM_PROMPT).digest("hex"),
} as const;

interface Answer {
  readonly verdict: Verdict;
  readonly note: string;
}

const answerSchema = jsonSchema<{ verdicts: Answer[] }>({
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: { verdict: { type: "string", enum: [...VERDICTS] }, note: { type: "string" } },
        required: ["verdict", "note"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdicts"],
  additionalProperties: false,
});

/** Only a provider that is briefly unwell earns a wait. Everything else is
 *  retried immediately, because a judge can also just flake once. */
const TRANSIENT = /\b(429|500|502|503|504|529)\b|overload|rate.?limit|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|fetch failed|network|timed? ?out/i;
const MAX_ATTEMPTS = 3;

/**
 * Identity, struck out of every piece of text evidence.
 *
 * Both columns name the product in their own source, in opposite ways: the
 * in-house baseline because its prompt tells it to call `vendo.callTool`, and
 * the product because its document is stamped `vendo/app@1`. Left alone, the
 * artifact hands the judge the answer in the channel it reads most closely —
 * and hands it BACKWARDS half the time, since the baseline's document is the
 * one that says the name out loud.
 *
 * The artifact's FORMAT is deliberately untouched: a tree still reads as a
 * tree and a document still reads as a document. That tell is disclosed, not
 * hidden — only the name goes.
 */
const IDENTITY = /\bvendo\b|\bdiy\b|\bclaude[\w-]*/gi;
const blind = (text: string): string => text.replace(IDENTITY, "host");

/** The probe's record as prose, because that is what a judge reads best. */
function traceText(trace: readonly Probed[]): string {
  if (trace.length === 0) return "Nothing on this screen could be pressed.";
  return trace
    .map((probed) => {
      const asked = probed.calls.map((call) => `${call.name}(${JSON.stringify(call.args)})`).join(", ");
      const step = probed.confirmed ? " (a confirmation step appeared, and was confirmed)" : "";
      return `pressed "${probed.label}"${step} — ${asked === "" ? "called nothing" : `called ${asked}`}`;
    })
    .join("\n");
}

/** Fisher-Yates: `order[position]` is the line that was asked in that slot. */
function shuffle(count: number): number[] {
  const order = Array.from({ length: count }, (_, index) => index);
  for (let index = count - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [order[index], order[swap]] = [order[swap]!, order[index]!];
  }
  return order;
}

/** A judge that answered a different number of lines, or answered one with a
 *  verdict outside the rubric, has not graded this screen — `jsonSchema` alone
 *  validates nothing at runtime, and no provider enforces an enum for us. */
const wellFormed = (verdicts: readonly Answer[] | undefined, expected: number): boolean =>
  Array.isArray(verdicts) &&
  verdicts.length === expected &&
  verdicts.every(
    (answer) => typeof answer?.note === "string" && (VERDICTS as readonly string[]).includes(answer.verdict),
  );

/** The provider reads ANTHROPIC_API_KEY itself, and says so by name when it is
 *  missing — which is a better sentence than one written here, and it arrives
 *  inside the retry loop, so a keyless run degrades instead of throwing. */
const pinnedModel = (): LanguageModel => createAnthropic()(JudgeContract.model);

/** One schema-constrained judgement with owned retries. Never throws: an
 *  unusable judge is a degraded result, never a half-graded screen. */
async function ask(
  input: JudgeInput,
  checklist: string,
  expected: number,
  options: JudgeOptions,
): Promise<{ ok: true; verdicts: Answer[] } | { ok: false; error: string }> {
  const delayMs = options.delayMs ?? ((attempt: number) => 1500 * (attempt + 1));
  let error = "the judge returned nothing";

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const result = await generateObject({
        model: options.model ?? pinnedModel(),
        schema: answerSchema,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", image: input.screenshot, mediaType: "image/png" },
              { type: "text", text: `SOURCE — what this screen was built from:\n\n${blind(input.artifact)}` },
              {
                type: "text",
                text: `INTERACTION TRACE — every control was pressed once:\n\n${blind(traceText(input.trace))}`,
              },
              { type: "text", text: `CHECKLIST — return one verdict per line, in this order:\n\n${checklist}` },
            ],
          },
        ],
        // The SDK's retries are off so the loop above owns every attempt, and
        // the attempt count in a degraded result means what it says.
        maxRetries: 0,
      });
      const { verdicts } = result.object;
      if (!wellFormed(verdicts, expected)) {
        throw new Error(`the judge usably answered ${verdicts?.length ?? 0} of ${expected} lines`);
      }
      return { ok: true, verdicts };
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : String(thrown);
      if (TRANSIENT.test(error) && attempt < MAX_ATTEMPTS - 1) {
        await new Promise((settle) => setTimeout(settle, delayMs(attempt)));
      }
    }
  }
  return { ok: false, error };
}

export async function judge(input: JudgeInput, options: JudgeOptions = {}): Promise<JudgeResult> {
  const lines: ReadonlyArray<{ line: string; source: LineSource }> = [
    ...input.caseLines.map((line) => ({ line, source: "case" as const })),
    ...input.styleLines.map((line) => ({ line, source: "style" as const })),
  ];
  if (lines.length === 0) return { lines: [], degraded: false };

  const order = shuffle(lines.length);
  const checklist = order.map((line, position) => `${position + 1}. ${lines[line]!.line}`).join("\n");

  const answered = await ask(input, checklist, lines.length, options);
  if (!answered.ok) {
    return {
      lines: lines.map((entry) => ({ ...entry, verdict: "fail", note: "the judge did not grade this screen" })),
      degraded: true,
      error: answered.error,
    };
  }

  // Back to the order the caller gave: the verdict asked in slot `position`
  // belongs to line `order[position]`, wherever that line started. The line and
  // its source are copied from the CALLER's entry, never from the answer — a
  // judge that echoes a paraphrased line back must not rewrite the rubric.
  const byLine = new Map(order.map((line, position) => [line, answered.verdicts[position]!]));
  return {
    lines: lines.map((entry, index) => {
      const answer = byLine.get(index)!;
      return { line: entry.line, source: entry.source, verdict: answer.verdict, note: answer.note };
    }),
    degraded: false,
  };
}
