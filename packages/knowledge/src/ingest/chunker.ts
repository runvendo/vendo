import type { KnowledgeChunk, KnowledgeChunker, KnowledgeDoc } from "@vendoai/core";
import { splitBlocks, splitHeadingSections } from "./markdown.js";

/** Soft per-chunk character budget. Chunks split only at structural
    boundaries (headings, then blank-line blocks), never mid-paragraph and
    never inside a code fence, so a single oversize atomic block stays whole
    rather than being cut. */
const CHUNK_BUDGET = 1200;

const headingPath = (path: string[]): string | undefined =>
  path.length === 0 ? undefined : path.join(" > ");

/** Packs a section's blocks into budget-sized runs, splitting only between
    blocks. The section's own lines (heading included) stay leading. */
function packSection(lines: string[], budget: number): string[] {
  const whole = lines.join("\n").trim();
  if (whole.length === 0) return [];
  if (whole.length <= budget) return [whole];
  const packed: string[] = [];
  let current = "";
  for (const block of splitBlocks(lines)) {
    const joined = current.length === 0 ? block : `${current}\n\n${block}`;
    if (current.length > 0 && joined.length > budget) {
      packed.push(current);
      current = block;
    } else {
      current = joined;
    }
  }
  if (current.length > 0) packed.push(current);
  return packed;
}

/** Knowledge design v2 R1 — the v1 structural chunker. Prose (`docs`) splits
    at h1-h6 boundaries (fence-aware — a heading inside a code block never
    splits) with the accumulated heading path on every chunk and a soft size
    budget applied at blank-line block boundaries. Glossary/api docs chunk
    one entry per heading-delimited term, budget-exempt: an entry is the
    atomic unit of exact lookup. Chunk ids are `<docId>#<index>` — stable
    across runs because the split is deterministic. */
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
