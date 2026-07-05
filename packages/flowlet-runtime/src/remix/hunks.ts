/**
 * Line-hunk application (remix fast-edits spec, 2026-07-04). The delta
 * encoding `edit_view` accepts: every string is a single line, so tool-call
 * JSON never carries an embedded newline — the raw-control-char truncation
 * class dies structurally, and mismatches produce deterministic, correctable
 * errors instead of a wrong merge.
 *
 * Two addressing modes per hunk (yousef-approved speed follow-up):
 * - COORDINATE mode — `endLine`, no `oldLines`: replaces lines
 *   [startLine, endLine] inclusive, trusting the op's `baseHash` (which
 *   already pins the exact base text server-side). Fewer output tokens and
 *   structurally immune to quote-mismatch retries. Preferred.
 * - EXACT-MATCH mode — `oldLines`: the classic quote-and-verify form;
 *   `oldLines: []` inserts before `startLine` (lineCount+1 appends). When
 *   both are present they must agree.
 *
 * Contract otherwise unchanged: 1-based coordinates against the LF-normalized
 * ORIGINAL base for every hunk in a call; atomic apply in descending order;
 * overlaps rejected.
 */

export const HUNK_MAX_HUNKS_PER_OP = 32;
export const HUNK_MAX_LINE_CHARS = 2000;

export interface Hunk {
  /** 1-based line in the ORIGINAL base text. */
  startLine: number;
  /** 1-based inclusive end of the replaced range (coordinate mode). */
  endLine?: number;
  /** Exact lines being replaced (exact-match mode); empty = insert before
   *  `startLine`. Optional when `endLine` is given. */
  oldLines?: string[];
  /** Replacement lines; empty = delete. */
  newLines: string[];
}

export type HunkError =
  | { code: "caps"; message: string }
  | { code: "lines"; message: string }
  | { code: "range"; message: string; startLine: number }
  | { code: "overlap"; message: string; startLine: number }
  | {
      code: "mismatch";
      message: string;
      startLine: number;
      /** What the base ACTUALLY says at the hunk's range — echoed back so the
       *  model can retry with corrected oldLines in one cheap turn. */
      actualLines: string[];
    };

export type HunkResult = { ok: true; text: string } | { ok: false; error: HunkError };

/** Single-line discipline for every string that claims to be a line. */
export function validateHunkLines(lines: string[]): string | undefined {
  for (const line of lines) {
    if (/[\r\n]/.test(line)) {
      return "line strings must be single lines — split on newlines into separate array entries";
    }
    if (line.length > HUNK_MAX_LINE_CHARS) {
      return `line exceeds ${HUNK_MAX_LINE_CHARS} chars — split it`;
    }
  }
  return undefined;
}

/** Lines replaced by a hunk (0 = pure insert), or an error message. */
function rangeLength(hunk: Hunk, startLine: number): number | string {
  if (hunk.endLine !== undefined) {
    if (!Number.isInteger(hunk.endLine) || hunk.endLine < startLine) {
      return `endLine ${hunk.endLine} must be >= startLine ${startLine}`;
    }
    const span = hunk.endLine - startLine + 1;
    if (hunk.oldLines !== undefined && hunk.oldLines.length !== span) {
      return `oldLines (${hunk.oldLines.length} lines) disagrees with startLine-endLine (${span} lines) — drop one of them`;
    }
    return span;
  }
  if (hunk.oldLines !== undefined) return hunk.oldLines.length;
  return "each hunk needs either endLine (replace that range) or oldLines (exact match; [] inserts)";
}

export function applyHunks(base: string, hunks: Hunk[]): HunkResult {
  if (hunks.length > HUNK_MAX_HUNKS_PER_OP) {
    return {
      ok: false,
      error: { code: "caps", message: `at most ${HUNK_MAX_HUNKS_PER_OP} hunks per op` },
    };
  }
  for (const hunk of hunks) {
    const lineIssue = validateHunkLines([...(hunk.oldLines ?? []), ...hunk.newLines]);
    if (lineIssue) return { ok: false, error: { code: "lines", message: lineIssue } };
  }

  const lines = base.split("\n");

  // Validate every hunk against the ORIGINAL text first: apply is atomic.
  const spans = new Map<Hunk, number>();
  for (const hunk of hunks) {
    const { startLine } = hunk;
    const span = rangeLength(hunk, startLine);
    if (typeof span === "string") {
      return { ok: false, error: { code: "range", startLine, message: span } };
    }
    spans.set(hunk, span);
    const maxStart = span === 0 ? lines.length + 1 : lines.length;
    if (!Number.isInteger(startLine) || startLine < 1 || startLine > maxStart) {
      return {
        ok: false,
        error: {
          code: "range",
          startLine,
          message: `startLine ${startLine} is outside the base (1-${lines.length}${span === 0 ? ", or " + (lines.length + 1) + " to append" : ""})`,
        },
      };
    }
    if (startLine + span - 1 > lines.length) {
      return {
        ok: false,
        error: {
          code: "range",
          startLine,
          message: `hunk at line ${startLine} runs past the end of the base (${lines.length} lines)`,
        },
      };
    }
    if (hunk.oldLines !== undefined && hunk.oldLines.length > 0) {
      const actual = lines.slice(startLine - 1, startLine - 1 + hunk.oldLines.length);
      if (hunk.oldLines.some((line, i) => line !== actual[i])) {
        const endLine = startLine + hunk.oldLines.length - 1;
        return {
          ok: false,
          error: {
            code: "mismatch",
            startLine,
            actualLines: actual,
            message:
              `oldLines do not match the base at lines ${startLine}-${endLine}. ` +
              "Retry with oldLines set to the actual lines (echoed in actualLines), " +
              "or use startLine+endLine coordinates without oldLines.",
          },
        };
      }
    }
  }

  // Overlap check on [start, start+span) ranges; equal insert points are
  // ambiguous (apply order would decide their order) — rejected.
  const sorted = [...hunks].sort((a, b) => a.startLine - b.startLine);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    const prevEnd = prev.startLine + spans.get(prev)!; // exclusive
    const collide =
      cur.startLine < prevEnd ||
      (cur.startLine === prev.startLine && spans.get(prev) === 0);
    if (collide) {
      return {
        ok: false,
        error: {
          code: "overlap",
          startLine: cur.startLine,
          message: `hunks at lines ${prev.startLine} and ${cur.startLine} overlap — merge them into one hunk`,
        },
      };
    }
  }

  // Descending apply keeps original coordinates valid as lengths change.
  const out = [...lines];
  for (const hunk of [...sorted].reverse()) {
    out.splice(hunk.startLine - 1, spans.get(hunk)!, ...hunk.newLines);
  }
  return { ok: true, text: out.join("\n") };
}
