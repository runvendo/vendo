import type { z } from "zod";

/**
 * A tolerant parse for the judge stage's fenced JSON artifact.
 *
 * `parseArtifact` (cli/extract/harness.ts) calls bare `JSON.parse` on the fenced
 * block, so a single stray character anywhere in the output throws away every
 * grade in the batch. Two preserved corpus runs show this is not a hypothetical:
 *
 * - rallly batch 5: 16,370 characters, 20 complete tool grades, the tools array
 *   properly closed — killed by a TRAILING COMMA after the narrative. Cost: 20
 *   tools unjudged and 5 legitimate downgrades lost.
 * - teable batch 1: 3,420 characters, both grades complete and correct — killed
 *   by a MISSING `]` on `missedSurfaces`. Cost: the repo's entire score (0.000).
 *
 * Neither is token truncation: the closing brace and the fence are both present,
 * and there is no size threshold. They are ordinary syntax slips two or three
 * characters from the end of otherwise-perfect work.
 *
 * WHY THIS LIVES HERE AND NOT IN `parseArtifact`
 * The repair is deliberately scoped to the judge stage rather than added to the
 * shared helper. `parseArtifact` is also the parse for init's extraction stages
 * (survey, draft, cross-check, brief, theme), whose schemas and failure
 * semantics are different and whose behavior is covered by other lanes' tests.
 * Silently changing how those parse is a wider blast radius than this bug
 * justifies, and the harnesses are a read-only dependency for this module.
 *
 * WHAT THIS MUST NEVER DO
 * Turn a parse failure into a silent empty success. A cheerful "0 tools judged"
 * is strictly worse than a loud failure, because the loud one gets retried and
 * the quiet one gets scored. Two properties enforce that:
 *
 * 1. every repair is purely ADDITIVE (insert missing closers) or removes a
 *    redundant comma. No repair can drop an array element, so a recovered batch
 *    always has at least the grades the model actually wrote;
 * 2. this module never scans for "some object that happens to validate". The
 *    judge envelope requires `tools`, so a bare inner tool object cannot pose as
 *    an empty result — which is exactly the trap a span-scanning fallback falls
 *    into when the envelope's `tools` has a `.default([])`.
 *
 * If the repair does not yield something the schema accepts, this throws.
 */

const FENCED_BLOCK = /```(?:json)?\s*\n([\s\S]*?)\n```/;

/**
 * Repair the two malformations real judge output produces, string-aware so a
 * brace or comma inside an evidence quote is never touched:
 *
 * - a comma followed only by whitespace and then `}` or `]` is dropped;
 * - a closer that does not match the innermost open bracket first emits the
 *   closers that are missing (`{"a": ["x"}` → `{"a": ["x"]}`);
 * - anything still open at EOF is closed, innermost first, including an
 *   unterminated string.
 *
 * Returns the repaired text, or null when the input has no `{` to work with.
 */
export function repairJson(raw: string): string | null {
  if (!raw.includes("{") && !raw.includes("[")) return null;

  const out: string[] = [];
  /** Open brackets, innermost last. */
  const stack: Array<"{" | "["> = [];
  let inString = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!;

    if (inString) {
      out.push(char);
      // A backslash escapes the next character, so `\"` does not end the string.
      if (char === "\\" && index + 1 < raw.length) {
        index += 1;
        out.push(raw[index]!);
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      out.push(char);
      continue;
    }

    if (char === "{" || char === "[") {
      stack.push(char);
      out.push(char);
      continue;
    }

    if (char === "}" || char === "]") {
      const wanted = char === "}" ? "{" : "[";
      // Close anything opened inside this one that the model forgot to close.
      while (stack.length > 0 && stack[stack.length - 1] !== wanted) {
        out.push(stack.pop() === "{" ? "}" : "]");
      }
      if (stack.length > 0) stack.pop();
      out.push(char);
      continue;
    }

    if (char === ",") {
      // Look past whitespace: a comma immediately before a closer is redundant.
      let ahead = index + 1;
      while (ahead < raw.length && /\s/.test(raw[ahead]!)) ahead += 1;
      const next = raw[ahead];
      // `undefined` means end of input, where the auto-closers below are about
      // to supply the closer — so this comma is redundant there too. It is the
      // commonest truncation of all: a batch cut right after a complete grade.
      if (next === undefined || next === "}" || next === "]") continue;
      out.push(char);
      continue;
    }

    out.push(char);
  }

  if (inString) out.push('"');
  while (stack.length > 0) out.push(stack.pop() === "{" ? "}" : "]");
  return out.join("");
}

export interface ParsedJudgeArtifact<T> {
  artifact: T;
  /** True when the raw output needed repair — the caller warns, never hides it. */
  repaired: boolean;
}

/**
 * Parse the judge artifact out of an agent's final text. Prefers the fenced
 * block; repairs it if it will not parse; throws if the result still does not
 * satisfy the schema.
 */
export function parseJudgeArtifact<Schema extends z.ZodTypeAny>(
  text: string,
  schema: Schema,
): ParsedJudgeArtifact<z.infer<Schema>> {
  const fenced = text.match(FENCED_BLOCK)?.[1];
  // No fence: the whole reply is the candidate. Note this is NOT a span scan —
  // the text is tried once, as-is, so nothing can match a sub-object by luck.
  const candidate = fenced ?? text;

  try {
    return { artifact: schema.parse(JSON.parse(candidate)) as z.infer<Schema>, repaired: false };
  } catch (firstError) {
    const repaired = repairJson(candidate);
    if (repaired === null || repaired === candidate) throw firstError;
    try {
      return { artifact: schema.parse(JSON.parse(repaired)) as z.infer<Schema>, repaired: true };
    } catch {
      // Report the ORIGINAL failure: the repair is a rescue attempt, and its own
      // error would only describe the rescue, not what the model got wrong.
      throw firstError;
    }
  }
}
