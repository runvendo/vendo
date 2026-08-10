import type { Json, ToolResult } from "@vendoai/core";

/**
 * What a turn has already learned from its own tool calls — the one thing the
 * loop could not see.
 *
 * A tool that runs fine and answers nothing reaches the model as
 * `{"status":"ok","output":{"components":[]}}`, which is indistinguishable from
 * the first look at an empty result, and nothing in the prompt accounts for what
 * the turn has already asked. Measured across 29 screen runs: 60 calls to one
 * search tool, every one answering an empty array, 631 seconds spent, one run
 * asking the identical question nine times.
 *
 * So the lesson is attached to the RESULT, where the model is already reading and
 * exactly when it matters, rather than to the prompt, where it would be advice
 * about a situation that usually never arises. Two lessons, and only two:
 *
 *  - THE SAME QUESTION, asked again, answered the same nothing. A repeat is never
 *    banned and never short-circuited: a transient failure genuinely deserves a
 *    second try, and a tool that fails once and works on the retry has to keep
 *    working. The note is written only once the repeat has ALSO come back empty or
 *    failed — at which point it is a statement of fact, not a guess.
 *  - NOTHING WORKED. When every call a turn made has failed, an admission is the
 *    right answer, and the model has to be told at the moment it decides whether
 *    to try again or speak.
 *
 * An ok-but-empty result is DATA ("you have no pending transfers"), never a
 * failure, so it never feeds the second lesson: telling a model that a
 * legitimately empty list means it "could not get the data" would buy one
 * fabrication to stop another.
 */
export interface CallLedger {
  /**
   * Record what one call answered, and return what the model should read beside
   * it — `undefined` for the overwhelming majority of calls, which teach the turn
   * nothing it does not already know.
   */
  note(name: string, args: Json, result: ToolResult): string | undefined;
}

/**
 * Did an `ok` result carry anything at all? `null`, `""`, `[]`, `{}` and
 * `{ components: [] }` are all a tool running fine and saying nothing. A number or
 * a boolean IS an answer, however small — and so is any non-blank string.
 */
function answeredNothing(output: Json): boolean {
  if (output === null || output === undefined) return true;
  if (typeof output === "string") return output.trim() === "";
  if (Array.isArray(output)) return output.length === 0;
  if (typeof output === "object") {
    return Object.values(output as Record<string, unknown>).every(answeredNothing);
  }
  return false;
}

/**
 * Two calls are the same question when the tool and every argument match. Keys are
 * SORTED: the same arguments re-serialized in another order are the same question,
 * and a fingerprint blind to that would never fire on the repeat it exists to
 * catch.
 */
function canonical(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([key, item]) => `${key}:${canonical(item)}`)
    .join(",")}}`;
}

const REPEATED_EMPTY =
  "You have already made this exact call and it returned nothing. The same arguments will not "
  + "give a different answer — change them, use a different tool, or carry on without this data.";

const repeatedFailure = (attempts: number): string =>
  `This exact call has now failed ${attempts} times. Repeating it unchanged is unlikely to help — `
  + "try a different tool or approach, or say what you could not do.";

const NOTHING_WORKED =
  "Every tool call so far has failed and none has succeeded. Do not answer from memory or with "
  + "figures you could not read — tell the person plainly what you could not get.";

/** One ledger per turn: the runtime builds it where it builds the turn's tools. */
export function createCallLedger(): CallLedger {
  /** How many times each exact question has come back with each KIND of nothing.
   *  The kind is part of the key so neither note can claim the wrong history: a
   *  question that answered empty once and then failed has not "failed twice". */
  const fruitless = new Map<string, number>();
  let worked = 0;
  let failed = 0;
  return {
    note(name, args, result) {
      // A denial is a decision, not a dead end. It already says what it needs, and
      // counting it would make both lessons untrue — a turn whose one write is
      // awaiting a tap has not "failed", and asking again after the tap is right.
      if (result.status === "denied") return undefined;
      // An ok-but-empty answer is still a call that WORKED; it just has nothing to
      // say. That is the whole reason it never feeds the nothing-worked lesson.
      if (result.status === "ok") worked += 1;
      else failed += 1;
      const empty = result.status === "ok" && answeredNothing(result.output);
      // A call that came back with data teaches the turn nothing it needs told.
      if (result.status === "ok" && !empty) return undefined;
      const question = canonical([name, args, empty]);
      const attempts = (fruitless.get(question) ?? 0) + 1;
      fruitless.set(question, attempts);
      const notes = [
        ...(attempts > 1 ? [empty ? REPEATED_EMPTY : repeatedFailure(attempts)] : []),
        // One failure is not "nothing worked" — it is a call that may yet be
        // retried, which is exactly what the retry note above refuses to prejudge.
        ...(worked === 0 && failed > 1 ? [NOTHING_WORKED] : []),
      ];
      return notes.length === 0 ? undefined : notes.join(" ");
    },
  };
}
