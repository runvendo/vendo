import { generateObject } from "ai";
import type { LanguageModel } from "ai";
import { z } from "zod";

/**
 * The reusable LLM judge (spec §Evals 3) — the declared shared judge surface
 * for the future self-improving eval lane. The core (`runJudge`) is generic:
 * schema-constrained `generateObject` (the packages/guard/src/judge.ts
 * pattern) with the bench judge's retry/degrade posture
 * (packages/apps/src/bench/judge.ts): transient provider errors retry with
 * backoff, anything else degrades to a floor result instead of throwing.
 * Knowledge specifics live only in the rubric layer at the bottom — keep it
 * that way.
 */

/** Env pin for the judge model. Judging runs on an independent, stronger
    tier than the answerer to avoid self-preference bias (the W1-bench
    discipline). */
export const JUDGE_MODEL_ENV = "VENDO_KNOWLEDGE_JUDGE_MODEL";
export const DEFAULT_JUDGE_MODEL = "claude-opus-4-8";

export function judgeModelId(env: NodeJS.ProcessEnv = process.env): string {
  return env[JUDGE_MODEL_ENV] ?? DEFAULT_JUDGE_MODEL;
}

const TRANSIENT = /429|502|503|504|overloaded|529|rate|ECONNRESET|timeout|fetch failed/i;

export interface RunJudgeOptions<Schema extends z.ZodTypeAny> {
  model: LanguageModel;
  schema: Schema;
  system: string;
  prompt: string;
  maxAttempts?: number;
  /** Backoff before retry `attempt` (0-based). Injectable so tests never sleep. */
  delayMs?: (attempt: number) => number;
}

export type JudgeOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/** One schema-constrained judgement with owned retries. Never throws: an
    unusable judge (persistent transport failure, unparseable output) is a
    degraded result the caller floors, mirroring the bench judge. */
export async function runJudge<Schema extends z.ZodTypeAny>(
  options: RunJudgeOptions<Schema>,
): Promise<JudgeOutcome<z.infer<Schema>>> {
  const maxAttempts = options.maxAttempts ?? 3;
  const delayMs = options.delayMs ?? ((attempt: number) => 1500 * (attempt + 1));
  let lastError = "judge produced no result";

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const result = await generateObject({
        model: options.model,
        schema: options.schema,
        system: options.system,
        prompt: options.prompt,
        maxRetries: 0,
      });
      return { ok: true, value: result.object };
    } catch (error) {
      lastError = String((error as Error)?.message ?? error);
      // Garbage/schema-miss output is retried too — a judge can flake once —
      // but only transport errors earn a backoff sleep.
      if (TRANSIENT.test(lastError) && attempt < maxAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs(attempt)));
      }
    }
  }
  return { ok: false, error: lastError };
}

// --- Rubric layer: the knowledge answer judgement -------------------------

export const KNOWLEDGE_JUDGE_AXES = ["faithfulness", "citationCorrectness", "completeness"] as const;
export type KnowledgeJudgeAxis = (typeof KNOWLEDGE_JUDGE_AXES)[number];

const axisSchema = z.object({
  /** 1-5; clamped after parse so a wild judge cannot skew aggregates. */
  score: z.number(),
  verdict: z.boolean(),
  note: z.string(),
});

export const knowledgeAnswerJudgementSchema = z.object({
  faithfulness: axisSchema,
  citationCorrectness: axisSchema,
  completeness: axisSchema,
});

export type KnowledgeAnswerJudgement = z.infer<typeof knowledgeAnswerJudgementSchema>;

export interface JudgedAnswer extends KnowledgeAnswerJudgement {
  /** True when the judge degraded (error or unusable output): every axis is
      floored at score 1 / verdict false and `error` says why. */
  degraded: boolean;
  error?: string;
}

export interface KnowledgeAnswerInput {
  question: string;
  answer: string;
  /** What the answer cites: doc id + the snippet text it leaned on. */
  citations: { docId: string; snippet: string }[];
  /** The golden item's expected answer key points. */
  keyPoints: string[];
}

const RUBRIC = `You are an impartial judge grading a documentation-grounded answer. You get the user QUESTION, the ANSWER, the CITED SNIPPETS the answer claims as evidence, and the expected KEY POINTS.

Grade three axes, each with an integer score 1-5, a boolean verdict, and a one-sentence note:
- faithfulness: is every claim in the answer entailed by the cited snippets? verdict true only when NO claim lacks support. 5 = fully entailed; 1 = fabricated or contradicts the snippets.
- citationCorrectness: does each citation actually support the statement it is attached to? verdict true only when every citation supports its statement. 5 = all correct; 1 = citations are decorative or wrong.
- completeness: are the expected key points covered? verdict true only when all key points are addressed. 5 = all covered; 1 = misses nearly all.

Judge strictly. An answer that refuses or says the docs do not cover the question is NOT faithful to snippets it does not cite — grade what is actually written.`;

function clampAxis(axis: z.infer<typeof axisSchema>): z.infer<typeof axisSchema> {
  const rounded = Math.round(axis.score);
  return { ...axis, score: Math.max(1, Math.min(5, Number.isFinite(rounded) ? rounded : 1)) };
}

function flooredJudgement(error: string): JudgedAnswer {
  const axis = { score: 1, verdict: false, note: "judge degraded" };
  return {
    faithfulness: { ...axis },
    citationCorrectness: { ...axis },
    completeness: { ...axis },
    degraded: true,
    error,
  };
}

export type KnowledgeAnswerJudge = (input: KnowledgeAnswerInput) => Promise<JudgedAnswer>;

export interface CreateKnowledgeAnswerJudgeOptions {
  model: LanguageModel;
  maxAttempts?: number;
  delayMs?: (attempt: number) => number;
}

export function createKnowledgeAnswerJudge(options: CreateKnowledgeAnswerJudgeOptions): KnowledgeAnswerJudge {
  return async (input) => {
    const outcome = await runJudge({
      model: options.model,
      schema: knowledgeAnswerJudgementSchema,
      system: RUBRIC,
      prompt: JSON.stringify({
        question: input.question,
        answer: input.answer,
        citedSnippets: input.citations,
        keyPoints: input.keyPoints,
      }),
      ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
      ...(options.delayMs === undefined ? {} : { delayMs: options.delayMs }),
    });
    if (!outcome.ok) return flooredJudgement(outcome.error);
    return {
      faithfulness: clampAxis(outcome.value.faithfulness),
      citationCorrectness: clampAxis(outcome.value.citationCorrectness),
      completeness: clampAxis(outcome.value.completeness),
      degraded: false,
    };
  };
}
