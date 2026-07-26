/**
 * Hand-rolled, dependency-free markdown structure scanning (greenfield by
 * design — zero markdown deps). The fence-aware splitter is the algorithm
 * from packages/ui/src/chrome/markdown.tsx (React-local, so copied rather
 * than imported), extended from h2/h3 to h1-h6 with heading-path
 * accumulation.
 */

/** ATX headings h1-h6, CommonMark-shaped: up to 3 leading spaces, required
    space after the marker, optional closing hash run. */
const HEADING = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;

const FENCE_RUN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

export interface MarkdownSection {
  /** Heading text, "" for the preamble before the first heading. */
  heading: string;
  /** 1-6; 0 for the preamble. */
  level: number;
  /** Ancestor headings down to and including this one ([] for the preamble). */
  path: string[];
  /** Section lines, heading line included (the preamble has no heading line). */
  lines: string[];
}

/** Splits markdown into heading-delimited sections. CommonMark-faithful fence
    tracking: a fence closes only on a run of the SAME character, at least as
    long as the opener, with nothing else on the line — a heading inside a
    code block never becomes a section break. An unterminated fence swallows
    the rest of the document into the current section (structure past it is
    unreliable), which is the safe reading for chunking. */
export function splitHeadingSections(text: string): MarkdownSection[] {
  const sections: MarkdownSection[] = [{ heading: "", level: 0, path: [], lines: [] }];
  const stack: { level: number; text: string }[] = [];
  let fence: { char: "`" | "~"; len: number } | null = null;
  for (const line of text.split("\n")) {
    const run = FENCE_RUN.exec(line);
    if (run) {
      const char = run[1]![0] as "`" | "~";
      if (!fence) {
        fence = { char, len: run[1]!.length };
        sections[sections.length - 1]!.lines.push(line);
        continue;
      }
      if (char === fence.char && run[1]!.length >= fence.len && run[2]!.trim().length === 0) {
        fence = null;
        sections[sections.length - 1]!.lines.push(line);
        continue;
      }
    }
    const head = fence ? null : HEADING.exec(line);
    if (head) {
      const level = head[1]!.length;
      const heading = head[2]!.trim();
      while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
      stack.push({ level, text: heading });
      sections.push({ heading, level, path: stack.map((entry) => entry.text), lines: [line] });
    } else {
      sections[sections.length - 1]!.lines.push(line);
    }
  }
  return sections;
}

/** Normalizes raw file text for ingestion: BOM stripped, CRLF/CR folded to
    LF, trailing whitespace-only tail trimmed. Deliberately keeps markdown
    markup intact — heading structure is what the chunker keys on. */
export function normalizeText(raw: string): string {
  return raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trimEnd();
}

/** Splits section lines into blank-line-delimited blocks for budget packing.
    Fenced code is atomic: blank lines inside a fence never split, so a chunk
    boundary can never land inside code. */
export function splitBlocks(lines: string[]): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: { char: "`" | "~"; len: number } | null = null;
  const flush = (): void => {
    const text = current.join("\n").trimEnd();
    if (text.trim().length > 0) blocks.push(text);
    current = [];
  };
  for (const line of lines) {
    const run = FENCE_RUN.exec(line);
    if (run) {
      const char = run[1]![0] as "`" | "~";
      if (!fence) fence = { char, len: run[1]!.length };
      else if (char === fence.char && run[1]!.length >= fence.len && run[2]!.trim().length === 0) fence = null;
      current.push(line);
      continue;
    }
    if (!fence && line.trim().length === 0) flush();
    else current.push(line);
  }
  flush();
  return blocks;
}
