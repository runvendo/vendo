import { generateObject } from "ai";
import type { LanguageModel } from "ai";
import { z } from "zod";

/**
 * The verifier pass.
 *
 * A retrieval score cannot separate "we know this" from "we don't" — the cloud
 * calibration found the two populations overlapping across almost their whole
 * width. So a cheap model reads what the search actually returned and answers
 * one question: do these passages support answering this question at all? Not
 * supported → the tool returns its existing insufficient-evidence outcome and
 * the agent says it does not know, instead of writing a confident answer over
 * adjacent-topic evidence.
 *
 * Three properties are load-bearing, because the alternative to a wrong answer
 * must never be no answers at all:
 * - it is an ENHANCEMENT: no model, no verifier, today's behavior;
 * - it FAILS OPEN BUT MARKED: a timeout, a provider error, or output that does
 *   not fit the schema yields no verdict; the caller falls back to the shipped
 *   threshold decision AND flags the result unverified, so a verifier that did
 *   not run is never mistaken for one that passed;
 * - it is TIME-CAPPED, per call AND per turn: the verifier sits between the
 *   search and the tool's answer, so a hanging model must never become a
 *   hanging turn. The caller passes what is left of the turn's budget
 *   (agent-tools.ts KNOWLEDGE_VERIFY_TURN_BUDGET_MS) and this cap is the
 *   smaller of the two.
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

/** The schema-constrained verdict (spec §The verifier pass: "sufficient /
    insufficient plus the gap it found"). */
export interface KnowledgeVerdict {
  /** Can a correct answer to the question be written from these passages? */
  supported: boolean;
  /** The one fact the verifier hung its verdict on — present (supported) or
      missing (unsupported). K15: the gap is no longer discarded at the tool
      seam; it rides the refusal so the agent can say WHAT is missing and the
      gap log records something more useful than a score. */
  gap: string;
}

export interface KnowledgeVerifyOptions {
  /** Hard cap for THIS call, from the caller's remaining per-TURN budget. The
      verifier takes the smaller of this and its own per-call cap: one turn
      that verifies twice (chat → deep) must not cost twice the cap. */
  timeoutMs?: number;
}

export interface KnowledgeVerifier {
  /** A verdict, or `undefined` for NO VERDICT — the caller must treat
      undefined as "decide the way you would have without me, and mark the
      result unverified". Never throws. */
  verify(
    input: KnowledgeVerifierInput,
    options?: KnowledgeVerifyOptions,
  ): Promise<KnowledgeVerdict | undefined>;
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

/** The gap is load-bearing, not decoration: it rides the refusal into the
    model's context and into gap logging, so "" or "N/A" is a verdict with the
    evidence torn off. The schema rejects those, which means the model retries
    (generateObject) and, if it will not comply, the call yields NO VERDICT and
    the tool falls open MARKED — the honest outcome for a check that did not
    really run. Twelve characters is the shortest thing that can name a missing
    fact; the placeholder list is the set a model reaches for when it has
    nothing to say.

    Round 2: length alone let boilerplate through — "not enough info",
    "insufficient information", "the answer is unknown" all cleared 12
    characters while naming nothing, and a refusal justified by junk evidence
    is the exact failure this verifier exists to kill. So a gap must also be
    SPECIFIC: after normalizing, at least one word must be something other
    than generic refusal vocabulary — a fact, a topic, a framework — or the
    verdict is invalid and the tool falls open MARKED. */
const MIN_GAP_CHARS = 12;
const GAP_PLACEHOLDERS = new Set(["n/a", "na", "none", "null", "unknown", "no gap", "nogap", "-", "—"]);
/** Words that appear in every generic refusal and name nothing. A gap made
    ONLY of these is boilerplate however long it is; one word outside this set
    ("Vue", "pricing", "APY") is what makes a gap actionable. */
const GAP_BOILERPLATE_WORDS = new Set([
  // articles, pronouns, copulas, prepositions, conjunctions
  "the", "a", "an", "it", "its", "this", "that", "these", "those", "there",
  "is", "are", "was", "were", "be", "been", "being", "to", "of", "for",
  "from", "in", "on", "at", "by", "as", "with", "within", "about", "or",
  "and", "but", "so", "than", "then", "here", "given",
  // negation and modality (apostrophes are stripped before matching)
  "not", "no", "nor", "cannot", "cant", "can", "could", "would", "should",
  "will", "wont", "does", "do", "did", "doesnt", "dont", "didnt", "isnt",
  "arent", "wasnt", "werent",
  // the generic nouns of a refusal
  "answer", "answers", "question", "questions", "info", "information",
  "data", "evidence", "context", "detail", "details", "fact", "facts",
  "specifics", "content", "knowledge", "documentation", "docs", "doc",
  "document", "documents", "passage", "passages", "source", "sources",
  "snippet", "snippets", "text", "result", "results", "search", "gap",
  // the generic verbs of a refusal
  "cover", "covers", "covered", "covering", "state", "states", "stated",
  "say", "says", "said", "mention", "mentions", "mentioned", "provide",
  "provides", "provided", "contain", "contains", "contained", "include",
  "includes", "included", "address", "addresses", "addressed", "answered",
  "determine", "determined", "specify", "specified", "exist", "exists",
  "found", "find",
  // the generic qualifiers of a refusal
  "enough", "insufficient", "sufficient", "unknown", "unclear",
  "unavailable", "available", "missing", "lacking", "present", "specific",
  "relevant", "related", "needed", "required", "necessary", "directly",
  "explicitly", "only", "any", "some", "none", "more",
]);

const isUsableGap = (value: string): boolean => {
  const gap = value.trim();
  if (gap.length < MIN_GAP_CHARS) return false;
  if (GAP_PLACEHOLDERS.has(gap.toLowerCase().replace(/[.!]+$/, ""))) return false;
  const words = gap
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^a-z0-9/-]+/)
    .filter((word) => word.length > 0);
  return words.some((word) => !GAP_BOILERPLATE_WORDS.has(word));
};

const verdictSchema = z.object({
  supported: z.boolean(),
  gap: z.string().refine(isUsableGap, {
    message: "gap must name the specific fact that is present or missing — not a placeholder, not boilerplate like \"not enough information\"",
  }),
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
  "State the gap in one sentence: the fact the passages supply (supported) or the fact they are missing (not supported).",
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
    async verify(input, callOptions) {
      // No evidence supports nothing. Deterministic, and it spends nothing.
      if (input.passages.length === 0) {
        return { supported: false, gap: "The search returned no passages to answer from." };
      }
      // The caller's remaining turn budget never RAISES the per-call cap: it
      // is a second ceiling, not a replacement for the first.
      const cap = callOptions?.timeoutMs === undefined
        ? timeoutMs
        : Math.min(timeoutMs, callOptions.timeoutMs);

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
        }, cap);
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
        return result === undefined
          ? undefined
          : { supported: result.object.supported, gap: result.object.gap.trim() };
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
