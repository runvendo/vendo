import type { KnowledgeChunk, KnowledgeChunker, KnowledgeDoc } from "@vendoai/core";
import { splitBlocks, splitHeadingSections, startsWithFence } from "./markdown.js";

/** Soft per-chunk character budget. Chunks split at structural boundaries
    (headings, then blank-line blocks); an oversized block subdivides further
    — prose by sentence, then by line, then by hard slice — so no chunk is
    unbounded (checker round 1 fix 3). */
const CHUNK_BUDGET = 1200;

/** Fenced code stays atomic up to this hard cap (splitting mid-fence breaks
    the code block for readers, so it is a last resort): bounded beats
    pretty, so a fence beyond the cap hard-splits at line boundaries. */
const FENCE_HARD_CAP = CHUNK_BUDGET * 4;

const headingPath = (path: string[]): string | undefined =>
  path.length === 0 ? undefined : path.join(" > ");

/** Greedy pack: joins pieces (each already within `budget`) into runs of at
    most `budget` chars, never reordering. */
function pack(pieces: string[], budget: number, separator: string): string[] {
  const packed: string[] = [];
  let current = "";
  for (const piece of pieces) {
    const joined = current.length === 0 ? piece : `${current}${separator}${piece}`;
    if (current.length > 0 && joined.length > budget) {
      packed.push(current);
      current = piece;
    } else {
      current = joined;
    }
  }
  if (current.length > 0) packed.push(current);
  return packed;
}

/** Last-resort split for text with no usable boundaries: prefer line
    boundaries, slice single monster lines. Every result is ≤ `size`. */
function hardSplit(text: string, size: number): string[] {
  const lines = text.split("\n").flatMap((line) => {
    if (line.length <= size) return [line];
    const slices: string[] = [];
    for (let at = 0; at < line.length; at += size) slices.push(line.slice(at, at + size));
    return slices;
  });
  return pack(lines, size, "\n");
}

/** Subdivides one blank-line block to the budget: prose splits at
    sentence-ish boundaries first; fenced code keeps its atomic exception up
    to the hard cap. */
function subdivideBlock(block: string): string[] {
  if (block.length <= CHUNK_BUDGET) return [block];
  if (startsWithFence(block)) {
    return block.length <= FENCE_HARD_CAP ? [block] : hardSplit(block, FENCE_HARD_CAP);
  }
  const sentences = block.split(/(?<=[.!?])\s+/).flatMap((sentence) =>
    sentence.length <= CHUNK_BUDGET ? [sentence] : hardSplit(sentence, CHUNK_BUDGET));
  return pack(sentences, CHUNK_BUDGET, " ");
}

/** Packs a section's blocks into budget-sized runs. The section's own lines
    (heading included) stay leading; oversized blocks subdivide first so the
    result is bounded. */
function packSection(lines: string[], budget: number): string[] {
  const whole = lines.join("\n").trim();
  if (whole.length === 0) return [];
  if (whole.length <= budget) return [whole];
  return pack(splitBlocks(lines).flatMap(subdivideBlock), budget, "\n\n");
}

/** Knowledge design v2 R1 — the v1 structural chunker. Prose (`docs`) splits
    at h1-h6 boundaries (fence-aware — a heading inside a code block never
    splits, including fences opened in list items) with the accumulated
    heading path on every chunk and a soft size budget applied at blank-line
    block boundaries, subdividing oversized blocks so no chunk is unbounded.
    Glossary/api docs chunk one entry per heading-delimited term,
    budget-exempt: an entry is the atomic unit of exact lookup. Chunk ids are
    `<docId>#<index>` — stable across runs because the split is
    deterministic. */
export const structuralChunker: KnowledgeChunker = {
  version: 1,
  chunk(doc: KnowledgeDoc): KnowledgeChunk[] {
    const sections = splitHeadingSections(doc.text);
    const pieces: { text: string; heading?: string }[] = [];
    for (const section of sections) {
      const heading = headingPath(section.path);
      if (doc.kind === "glossary" || doc.kind === "api") {
        const whole = section.lines.join("\n").trim();
        if (whole.length > 0) pieces.push({ text: whole, ...(heading === undefined ? {} : { heading }) });
        continue;
      }
      for (const text of packSection(section.lines, CHUNK_BUDGET)) {
        pieces.push({ text, ...(heading === undefined ? {} : { heading }) });
      }
    }
    return pieces.map((piece, index) => ({
      docId: doc.id,
      chunkId: `${doc.id}#${index}`,
      text: piece.text,
      index,
      ...(piece.heading === undefined ? {} : { heading: piece.heading }),
    }));
  },
};
