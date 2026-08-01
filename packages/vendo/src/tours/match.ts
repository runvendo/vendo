/**
 * Which tour entry a typed message is asking for.
 *
 * A pure module, separate from the replay engine, because this is the part a
 * HUMAN drives: prompts are typed live in front of an audience, so a dropped
 * word, a lost em dash, or a typo must not be able to break the demo.
 *
 * IT USED TO MATCH KEYWORDS, AND THAT WAS THE BUG. In the Keystone build (the
 * reference implementation this is lifted from), "rent" plus any of
 * late/behind/overdue was enough to replay the cached dashboard, so a FOLLOW-UP
 * about that dashboard replayed it instead of editing it: "make the colour you
 * use to mark the late rent purple instead of red" scored a match, the cache
 * attached a second time, and the pin the audience had just watched land was
 * thrown away with it. Keyword matching cannot tell "ask for this" from "change
 * the thing you just made", because both sentences are about rent being late.
 *
 * So matching is STRICT and ONCE:
 *
 *  1. STRICT — an entry fires only on a close variant of one of its own frozen
 *     phrasings. Closeness is a high-threshold similarity score, so typos and
 *     small word swaps still land the entry, while a different ask about the
 *     same subject does not. The best-scoring entry wins, which retires
 *     order-dependence: one entry's phrasing may contain another's words.
 *  2. ONCE PER THREAD — an entry fires at most once in a conversation (the
 *     caller supplies which have already played). Everything after it falls
 *     through to the real agent, which is what makes a follow-up an EDIT of the
 *     app on screen rather than a second copy of it.
 *
 * Both rules point the same way: a tour answers the ask it was recorded for,
 * and nothing else. Everything else is the live agent's, on the live agent's
 * clock.
 */

/**
 * How close a typed line has to be to a frozen phrasing to count as that
 * phrasing. Tuned against the corpus in ./match.test.ts, which asserts both
 * directions: every frozen line and a one-typo-per-keyword mangling of it
 * clears the bar, and every real follow-up ask that must reach the live agent
 * stays well under it.
 *
 * 0.82 is deliberately close to the widest must-match (a whole clause dropped
 * scores ~0.79 and falls through). That is the right side to err on: an entry
 * that does not fire costs one retry, and an entry that fires wrongly costs the
 * demo. Not configurable — a threshold knob is a footgun whose only setting is
 * the one that re-creates the over-matching bug.
 */
const MATCH_THRESHOLD = 0.82;

/** Lowercase, punctuation-free, single-spaced — so "Rent — behind?" and "rent
 *  behind" are the same string, and an em dash typed as a hyphen is harmless. */
export function normalizePrompt(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Unique words, order-free — the half of the score that survives a reordered
 *  or half-remembered sentence. */
function tokenSet(normalized: string): Set<string> {
  return new Set(normalized.split(" ").filter((token) => token !== ""));
}

/** Sørensen–Dice over those sets. */
function tokenSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

/** Levenshtein distance, two rows rather than a full matrix. The strings here
 *  are one sentence long, so this is cheap enough to run against every
 *  phrasing of every entry on every turn. */
function editDistance(left: string, right: string): number {
  if (left === right) return 0;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const substitution = previous[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1);
      current[j] = Math.min(substitution, previous[j]! + 1, current[j - 1]! + 1);
    }
    previous = current;
  }
  return previous[right.length]!;
}

/** The half of the score that survives a typo INSIDE a word — the exact failure
 *  keyword matching could not see, because `includes` reads a corrupted keyword
 *  as an absent one. */
function characterSimilarity(left: string, right: string): number {
  const longest = Math.max(left.length, right.length);
  if (longest === 0) return 0;
  return 1 - editDistance(left, right) / longest;
}

/**
 * How much one typed line looks like one frozen phrasing: the better of the two
 * measures, because they fail in different places. A mangled word barely moves
 * the character score but drops a whole token; a reordered clause barely moves
 * the token score but wrecks the character one.
 */
function similarity(typed: string, phrasing: string): number {
  const normalizedPhrasing = normalizePrompt(phrasing);
  return Math.max(
    tokenSimilarity(tokenSet(typed), tokenSet(normalizedPhrasing)),
    characterSimilarity(typed, normalizedPhrasing),
  );
}

function bestScore(typed: string, phrasings: readonly string[]): number {
  return phrasings.reduce((best, phrasing) => Math.max(best, similarity(typed, phrasing)), 0);
}

/**
 * The index of the entry this message is asking for, or undefined to let the
 * real agent have it. Fail-open is the whole disposition: an unmatched line is
 * a working product on the live agent's path, and a wrongly matched line is a
 * replay of something the audience has already seen.
 *
 * `entries` is each entry's frozen phrasings in declaration order; `played` is
 * the indexes already spent in this thread.
 */
export function matchTour(input: {
  text: string;
  entries: readonly (readonly string[])[];
  played?: readonly number[];
}): number | undefined {
  const typed = normalizePrompt(input.text);
  if (typed === "") return undefined;
  const played = input.played ?? [];

  let winner: number | undefined;
  let winningScore = MATCH_THRESHOLD;
  for (const [index, phrasings] of input.entries.entries()) {
    // Spent. Everything after an entry's one turn is the live agent's, which is
    // what makes a follow-up an edit of the app on screen instead of a second
    // copy of it.
    if (played.includes(index)) continue;
    const score = bestScore(typed, phrasings);
    // Strictly greater, so the first entry declared wins a tie rather than the last.
    if (score > winningScore) {
      winner = index;
      winningScore = score;
    }
  }
  return winner;
}

/**
 * Could this text reach ANY entry, with nothing yet played?
 *
 * The seam's cheap gate. Deciding an entry for real means folding the whole
 * thread history through the matcher, so a line that cannot match anything
 * under any circumstances must not pay for that. Every improvised ask takes
 * this exit, which is why the live path costs what it did before tours existed.
 */
export function couldReachTour(text: string, entries: readonly (readonly string[])[]): boolean {
  return matchTour({ text, entries }) !== undefined;
}
