import { generateObject } from "ai";
import type { LanguageModel } from "ai";
import { z } from "zod";

/**
 * Knowledge K14 — the verifier pass.
 *
 * Inside the band (band.ts) the retrieval score carries no signal, so a cheap
 * model reads what the search actually returned and answers one question: do
 * these passages support answering this question at all? Not supported → the
 * tool returns its existing insufficient-evidence outcome and the agent says
 * it does not know, instead of writing a confident answer over adjacent-topic
 * evidence.
 *
 * Three properties are load-bearing, because the alternative to a wrong answer
 * must never be no answers at all:
 * - it is an ENHANCEMENT: no model, no verifier, today's behavior;
 * - it FAILS OPEN: a timeout, a provider error, or output that does not fit
 *   the schema yields no verdict, and the caller falls back to the shipped
 *   threshold decision;
 * - it is TIME-CAPPED: the verifier sits between the search and the tool's
 *   answer, so a hanging model must never become a hanging turn.
 */

/** One cited passage, as the tool would hand it to the model. */
export interface KnowledgeVerifierPassage {
  docId: string;
  title?: string;
  snippet: string;
}

export interface KnowledgeVerifierInput {
  question: string;
  passages: KnowledgeVerifierPassage[];
  /** The drafted answer, when the caller has one. The tool seam does not: it
      runs before the agent writes anything, so it asks the strictly-earlier
      half of the same question ("could ANY correct answer come from these?").
      A post-draft caller passes the draft here and the check narrows to it. */
  answer?: string;
}

export interface KnowledgeVerifier {
  /** `true` supported · `false` not supported · `undefined` no verdict —
      the caller must treat undefined as "decide the way you would have
      without me". Never throws. */
  supported(input: KnowledgeVerifierInput): Promise<boolean | undefined>;
}

/** The wall the verifier may not cross, set from measurement rather than
    taste: over 183 verifications of the calibration corpus on the shipped
    judge-slot model (docs/eval/KNOWLEDGE.md §The verifier pass) the median was
    1.6s, p95 4.0s, and a thin tail ran to 10s. 5s therefore keeps ~97% of
    verdicts while bounding what the verifier can add to a turn. The tail is
    not an error — a call that crosses the wall simply yields no verdict and the
    tool answers the way it would have without a verifier at all. */
export const KNOWLEDGE_VERIFY_TIMEOUT_MS = 5000;

export interface EntailmentVerifierOptions {
  model: LanguageModel;
  /** Hard cap on one verification. Default KNOWLEDGE_VERIFY_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Appended to the standard, for hosts with a domain-specific bar. */
  instructions?: string;
}

const verdictSchema = z.object({
  supported: z.boolean(),
  rationale: z.string(),
});

/** The standard, written for the failure the calibration actually found:
    unanswerable questions retrieve passages about the same product, and
    embedding similarity cannot tell "installing in a framework" from
    "installing in YOUR framework". */
const STANDARD = [
  "You are Vendo's evidence verifier. You are given a user's question and the passages a product knowledge base returned for it.",
  "Decide one thing: can a correct answer to that question be written from these passages alone?",
  "supported = true when the passages state the facts the question asks for. A partial answer counts, as long as the substance of the question is covered.",
  "supported = false when answering would require facts that are not present — most often passages that are about the same product, or answer a neighbouring question, without covering this one. \"How to install in framework A\" does not support \"how to install in framework B\"; a description of a feature does not support a question about its price.",
  "Judge only what the passages say. Do not use your own knowledge of the product to fill a gap.",
  "Give a one-sentence rationale naming the fact that is present or missing.",
].join("\n");

/** Passages are already trimmed by the tool; this bounds a pathological
    caller so one verification cannot become a large prompt. */
const MAX_PASSAGE_CHARS = 600;
const MAX_PASSAGES = 8;

/**
 * The shipped verifier: one schema-constrained call on a cheap model, capped
 * in time, never throwing. Follows `packages/guard/src/judge.ts` — the house
 * pattern for a model that returns a decision rather than prose.
 */
export function entailmentVerifier(options: EntailmentVerifierOptions): KnowledgeVerifier {
  const timeoutMs = options.timeoutMs ?? KNOWLEDGE_VERIFY_TIMEOUT_MS;
  const system = options.instructions === undefined ? STANDARD : `${STANDARD}\n\n${options.instructions}`;
  // Deduped by cause, like the engine-failure warning in agent-tools.ts: a
  // permanently misconfigured verifier costs one log line, not one per turn.
  const warned = new Set<string>();

  return {
    async supported(input) {
      // No evidence supports nothing. Deterministic, and it spends nothing.
      if (input.passages.length === 0) return false;

      const prompt = JSON.stringify({
        question: input.question,
        ...(input.answer === undefined ? {} : { draftedAnswer: input.answer }),
        passages: input.passages.slice(0, MAX_PASSAGES).map((passage) => ({
          docId: passage.docId,
          ...(passage.title === undefined ? {} : { title: passage.title }),
          text: passage.snippet.slice(0, MAX_PASSAGE_CHARS),
        })),
      });

      const controller = new AbortController();
      // Raced as well as aborted: a provider that ignores the signal must not
      // hold the turn open past the cap. Both timers are cleared in finally,
      // so a fast verdict never leaves one pending.
      let expire: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<undefined>((resolve) => {
        expire = setTimeout(() => {
          controller.abort();
          resolve(undefined);
        }, timeoutMs);
      });
      try {
        const result = await Promise.race([
          generateObject({
            model: options.model,
            schema: verdictSchema,
            system,
            prompt,
            abortSignal: controller.signal,
          }),
          deadline,
        ]);
        return result?.object.supported;
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error);
        if (!warned.has(cause)) {
          warned.add(cause);
          console.warn(`[vendo] knowledge verifier gave no verdict — falling back to the score threshold: ${cause}`);
        }
        return undefined;
      } finally {
        clearTimeout(expire);
      }
    },
  };
}
