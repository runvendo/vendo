import { describe, expect, it } from "vitest";
import {
  applyHunks,
  HUNK_MAX_HUNKS_PER_OP,
  HUNK_MAX_LINE_CHARS,
  validateHunkLines,
  type Hunk,
} from "./hunks.js";

const BASE = ["one", "two", "three", "four", "five"].join("\n");

const ok = (result: ReturnType<typeof applyHunks>) => {
  if (!result.ok) throw new Error(`expected ok, got: ${result.error.message}`);
  return result.text;
};

describe("applyHunks", () => {
  it("replaces a matching range", () => {
    const hunks: Hunk[] = [{ startLine: 2, oldLines: ["two", "three"], newLines: ["TWO"] }];
    expect(ok(applyHunks(BASE, hunks))).toBe(["one", "TWO", "four", "five"].join("\n"));
  });

  it("applies multiple hunks against ORIGINAL coordinates, atomically", () => {
    // An earlier hunk that changes line count must not shift a later one.
    const hunks: Hunk[] = [
      { startLine: 1, oldLines: ["one"], newLines: ["1a", "1b", "1c"] },
      { startLine: 4, oldLines: ["four"], newLines: ["FOUR"] },
    ];
    expect(ok(applyHunks(BASE, hunks))).toBe(
      ["1a", "1b", "1c", "two", "three", "FOUR", "five"].join("\n"),
    );
  });

  it("inserts before startLine when oldLines is empty, and appends at lineCount+1", () => {
    const insert: Hunk[] = [{ startLine: 3, oldLines: [], newLines: ["inserted"] }];
    expect(ok(applyHunks(BASE, insert))).toBe(
      ["one", "two", "inserted", "three", "four", "five"].join("\n"),
    );
    const append: Hunk[] = [{ startLine: 6, oldLines: [], newLines: ["six"] }];
    expect(ok(applyHunks(BASE, append))).toBe(`${BASE}\nsix`);
  });

  it("deletes when newLines is empty", () => {
    const hunks: Hunk[] = [{ startLine: 2, oldLines: ["two"], newLines: [] }];
    expect(ok(applyHunks(BASE, hunks))).toBe(["one", "three", "four", "five"].join("\n"));
  });

  it("rejects a mismatch, echoing the ACTUAL lines at the range", () => {
    const result = applyHunks(BASE, [
      { startLine: 2, oldLines: ["two", "WRONG"], newLines: ["x"] },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("mismatch");
    expect(result.error.startLine).toBe(2);
    expect(result.error.actualLines).toEqual(["two", "three"]);
    expect(result.error.message).toContain("lines 2-3");
  });

  it("rejects out-of-range coordinates", () => {
    const past = applyHunks(BASE, [{ startLine: 7, oldLines: [], newLines: ["x"] }]);
    expect(past.ok).toBe(false);
    if (!past.ok) expect(past.error.code).toBe("range");
    const zero = applyHunks(BASE, [{ startLine: 0, oldLines: ["one"], newLines: [] }]);
    expect(zero.ok).toBe(false);
    const overhang = applyHunks(BASE, [
      { startLine: 5, oldLines: ["five", "six"], newLines: [] },
    ]);
    expect(overhang.ok).toBe(false);
  });

  it("rejects overlapping hunks (touching ranges are fine)", () => {
    const overlap = applyHunks(BASE, [
      { startLine: 1, oldLines: ["one", "two"], newLines: [] },
      { startLine: 2, oldLines: ["two", "three"], newLines: [] },
    ]);
    expect(overlap.ok).toBe(false);
    if (!overlap.ok) expect(overlap.error.code).toBe("overlap");
    const adjacent = applyHunks(BASE, [
      { startLine: 1, oldLines: ["one"], newLines: ["ONE"] },
      { startLine: 2, oldLines: ["two"], newLines: ["TWO"] },
    ]);
    expect(adjacent.ok).toBe(true);
    // Two inserts at the same coordinate collide (ambiguous order) — reject.
    const sameInsert = applyHunks(BASE, [
      { startLine: 2, oldLines: [], newLines: ["a"] },
      { startLine: 2, oldLines: [], newLines: ["b"] },
    ]);
    expect(sameInsert.ok).toBe(false);
  });

  it("rejects more than the hunk cap", () => {
    const many: Hunk[] = Array.from({ length: HUNK_MAX_HUNKS_PER_OP + 1 }, (_, i) => ({
      startLine: 1,
      oldLines: [],
      newLines: [`l${i}`],
    }));
    const result = applyHunks(BASE, many);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("caps");
  });
});

describe("applyHunks — coordinate mode (endLine, no oldLines)", () => {
  it("replaces an explicit range trusting the base hash", () => {
    const hunks: Hunk[] = [{ startLine: 2, endLine: 3, newLines: ["TWO"] }];
    expect(ok(applyHunks(BASE, hunks))).toBe(["one", "TWO", "four", "five"].join("\n"));
  });

  it("deletes a range with empty newLines; single-line range via endLine=startLine", () => {
    expect(ok(applyHunks(BASE, [{ startLine: 2, endLine: 2, newLines: [] }]))).toBe(
      ["one", "three", "four", "five"].join("\n"),
    );
  });

  it("mixes coordinate and exact-match hunks in one call (original coordinates)", () => {
    const hunks: Hunk[] = [
      { startLine: 1, endLine: 1, newLines: ["1a", "1b"] },
      { startLine: 4, oldLines: ["four"], newLines: ["FOUR"] },
    ];
    expect(ok(applyHunks(BASE, hunks))).toBe(
      ["1a", "1b", "two", "three", "FOUR", "five"].join("\n"),
    );
  });

  it("rejects a hunk with NEITHER oldLines nor endLine, and endLine < startLine", () => {
    const neither = applyHunks(BASE, [{ startLine: 2, newLines: ["x"] } as Hunk]);
    expect(neither.ok).toBe(false);
    if (!neither.ok) expect(neither.error.code).toBe("range");
    const inverted = applyHunks(BASE, [{ startLine: 3, endLine: 2, newLines: ["x"] }]);
    expect(inverted.ok).toBe(false);
  });

  it("rejects BOTH oldLines and endLine when they disagree; accepts when consistent", () => {
    const disagree = applyHunks(BASE, [
      { startLine: 2, endLine: 4, oldLines: ["two"], newLines: ["x"] },
    ]);
    expect(disagree.ok).toBe(false);
    const agree = applyHunks(BASE, [
      { startLine: 2, endLine: 3, oldLines: ["two", "three"], newLines: ["x"] },
    ]);
    expect(agree.ok).toBe(true);
  });

  it("rejects out-of-range endLine", () => {
    const past = applyHunks(BASE, [{ startLine: 5, endLine: 6, newLines: ["x"] }]);
    expect(past.ok).toBe(false);
    if (!past.ok) expect(past.error.code).toBe("range");
  });

  it("overlap detection covers coordinate-mode ranges", () => {
    const overlap = applyHunks(BASE, [
      { startLine: 1, endLine: 2, newLines: [] },
      { startLine: 2, endLine: 3, newLines: [] },
    ]);
    expect(overlap.ok).toBe(false);
    if (!overlap.ok) expect(overlap.error.code).toBe("overlap");
  });
});

describe("validateHunkLines", () => {
  it("rejects embedded newlines and carriage returns anywhere", () => {
    expect(validateHunkLines(["fine"])).toBeUndefined();
    expect(validateHunkLines(["bad\nline"])).toMatch(/newline/i);
    expect(validateHunkLines(["bad\rline"])).toMatch(/newline/i);
  });

  it("rejects oversized lines", () => {
    expect(validateHunkLines(["x".repeat(HUNK_MAX_LINE_CHARS + 1)])).toMatch(/2000/);
  });
});
