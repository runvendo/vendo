/**
 * SEARCH/REPLACE against a saved document, plus the error that teaches.
 *
 * Ported from aider's edit formats (https://aider.chat/2023/12/21/unified-diffs.html).
 * Re-emitting a whole app document to move one number is the expensive half of a
 * revision, and aider's finding is that a diff format only works when two things
 * hold: the applier is FLEXIBLE about whitespace, and a block that fails to match
 * comes back with the failed text and the nearest real lines rather than a bare
 * "no match" — a failed block costs a round-trip, so a brittle applier is slower
 * than saving the whole file.
 *
 * Two of aider's four laws are already free here: the blocks arrive as tool
 * ARGUMENTS, so there are no fences to parse and no line numbers to get wrong.
 * What this file owns is the other two — leniency and the teaching error.
 *
 * All-or-nothing on purpose. A half-applied set of blocks leaves a document
 * nobody wrote, and the model's next `search` would be quoting lines that no
 * longer exist.
 */

/** One revision: lines copied off the document, and what they become. */
export interface EditBlock {
  readonly search: string;
  readonly replace: string;
}

export type EditOutcome =
  | { ok: true; document: string }
  | { ok: false; note: string };

/** The one rule a failed block needs to hear, in aider's own terms. */
const RULE = "SEARCH must reproduce existing lines of the document exactly; "
  + "include more surrounding lines to make it unique.";

const trimEnd = (line: string): string => line.replace(/\s+$/, "");

/** A block's lines. A block that ends with a newline ends on the line ABOVE it —
 *  it is not a block demanding a blank line in the document. */
const lines = (text: string): string[] => {
  const split = text.split("\n");
  if (split.length > 1 && split.at(-1) === "") split.pop();
  return split;
};

const tokens = (text: string): Set<string> => new Set(text.toLowerCase().match(/[a-z0-9_]+/g) ?? []);

/** The document lines that share the most words with the failed block — what
 *  turns "no match" into something the next attempt can act on. */
const closestLines = (document: string, search: string): string[] => {
  const wanted = tokens(search);
  return document
    .split("\n")
    .map((line) => ({ line, score: [...tokens(line)].filter((token) => wanted.has(token)).length }))
    .filter((scored) => scored.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((scored) => scored.line);
};

const noMatch = (document: string, search: string): EditOutcome => {
  const closest = closestLines(document, search);
  return {
    ok: false,
    note: [
      "That SEARCH block matched nothing in the document, so nothing was changed:",
      search,
      ...(closest.length === 0 ? [] : ["The closest lines in the document are:", closest.join("\n")]),
      RULE,
    ].join("\n\n"),
  };
};

const ambiguous = (search: string, count: number): EditOutcome => ({
  ok: false,
  note: [
    `That SEARCH block appears ${count} times — include more surrounding lines so it matches in exactly `
    + "one place. Nothing was changed:",
    search,
  ].join("\n\n"),
});

/**
 * Apply the blocks in order, or apply none of them.
 *
 * Two passes per block, leniency second:
 *
 * 1. the block as literal bytes, matching exactly once;
 * 2. line-wise, with trailing whitespace forgiven on both sides — the one
 *    difference a model reproducing lines from a prompt actually makes.
 */
export function applyEditBlocks(document: string, edits: readonly EditBlock[]): EditOutcome {
  if (edits.length === 0) return { ok: false, note: `No SEARCH/REPLACE block arrived, so nothing changed. ${RULE}` };
  let next = document;
  for (const edit of edits) {
    const exact = next.split(edit.search).length - 1;
    if (exact > 1) return ambiguous(edit.search, exact);
    if (exact === 1) {
      const at = next.indexOf(edit.search);
      next = next.slice(0, at) + edit.replace + next.slice(at + edit.search.length);
      continue;
    }
    const needle = lines(edit.search).map(trimEnd);
    const hay = next.split("\n");
    const found: number[] = [];
    for (let start = 0; start + needle.length <= hay.length; start += 1) {
      if (needle.every((line, offset) => trimEnd(hay[start + offset] ?? "") === line)) found.push(start);
    }
    if (found.length > 1) return ambiguous(edit.search, found.length);
    const start = found[0];
    if (start === undefined) return noMatch(next, edit.search);
    const spliced = [...hay];
    // An empty `replace` REMOVES the lines rather than leaving a blank one behind.
    spliced.splice(start, needle.length, ...(edit.replace === "" ? [] : lines(edit.replace)));
    next = spliced.join("\n");
  }
  return { ok: true, document: next };
}
