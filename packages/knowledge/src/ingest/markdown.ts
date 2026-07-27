/**
 * Hand-rolled, dependency-free markdown structure scanning (greenfield by
 * design — zero markdown deps). The fence-aware splitter is the algorithm
 * from packages/ui/src/chrome/markdown.tsx (React-local, so copied rather
 * than imported), extended from h2/h3 to h1-h6 with heading-path
 * accumulation and CommonMark-ish list-item fence handling (checker round 1
 * fix 2).
 */

/** ATX headings h1-h6, CommonMark-shaped: up to 3 leading spaces, required
    space after the marker, optional closing hash run. */
const HEADING = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;

/** A fence OPENER may sit inside a list item (`- ```md`): an optional
    bullet/ordered marker precedes the run. Group 1 = the run, group 2 = the
    info string. */
const FENCE_OPEN = /^ {0,3}(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)? {0,3}(`{3,}|~{3,})(.*)$/;

/** A fence CLOSER is a bare same-character run with nothing else on the
    line. Up to 5 leading spaces so closers indented under a list marker
    (`  ``` ` beneath `- `) still close; a list MARKER never closes a fence
    (`- ``` ` inside an open fence is content). */
const FENCE_CLOSE = /^ {0,5}(`{3,}|~{3,})[ \t]*$/;

/** CommonMark-faithful-enough fence state shared by every scanner in this
    module: a fence closes only on a run of the SAME character, at least as
    long as the opener — a heading (or blank line) inside a code block never
    becomes a structural boundary, including fences opened inside list
    items. An unterminated fence swallows the rest of the document into the
    current section, which is the safe reading for chunking. */
export function fenceTracker(): { feed(line: string): boolean; readonly open: boolean } {
  let fence: { char: "`" | "~"; len: number } | null = null;
  return {
    /** Consumes one line; true when the line IS fence syntax (open/close). */
    feed(line: string): boolean {
      if (fence === null) {
        const opened = FENCE_OPEN.exec(line);
        if (opened) {
          fence = { char: opened[1]![0] as "`" | "~", len: opened[1]!.length };
          return true;
        }
        return false;
      }
      const closed = FENCE_CLOSE.exec(line);
      if (closed && closed[1]![0] === fence.char && closed[1]!.length >= fence.len) {
        fence = null;
        return true;
      }
      return false;
    },
    get open(): boolean {
      return fence !== null;
    },
  };
}

/** True when the block's first line opens a code fence — used by the
    chunker to keep code atomic where prose would subdivide. */
export const startsWithFence = (block: string): boolean => FENCE_OPEN.test(block.split("\n", 1)[0]!);

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

/** Splits markdown into heading-delimited sections, fence-aware. */
export function splitHeadingSections(text: string): MarkdownSection[] {
  const sections: MarkdownSection[] = [{ heading: "", level: 0, path: [], lines: [] }];
  const stack: { level: number; text: string }[] = [];
  const fence = fenceTracker();
  for (const line of text.split("\n")) {
    const wasOpen = fence.open;
    if (fence.feed(line) || wasOpen) {
      sections[sections.length - 1]!.lines.push(line);
      continue;
    }
    const head = HEADING.exec(line);
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
    Fenced code is atomic here: blank lines inside a fence never split, so a
    block boundary can never land inside code. */
export function splitBlocks(lines: string[]): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  const fence = fenceTracker();
  const flush = (): void => {
    const text = current.join("\n").trimEnd();
    if (text.trim().length > 0) blocks.push(text);
    current = [];
  };
  for (const line of lines) {
    const wasOpen = fence.open;
    if (fence.feed(line) || wasOpen) {
      current.push(line);
      continue;
    }
    if (line.trim().length === 0) flush();
    else current.push(line);
  }
  flush();
  return blocks;
}
