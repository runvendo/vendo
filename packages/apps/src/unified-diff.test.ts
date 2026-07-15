import { describe, expect, it } from "vitest";
import { unifiedDiff } from "./unified-diff.js";

describe("unifiedDiff", () => {
  it("returns an empty string for identical inputs", () => {
    expect(unifiedDiff("card.tsx", "a\nb", "a\nb")).toBe("");
  });

  it("marks a single changed line with surrounding context", () => {
    const before = ["one", "two", "three", "four", "five", "six", "seven"].join("\n");
    const after = ["one", "two", "three", "FOUR", "five", "six", "seven"].join("\n");
    expect(unifiedDiff("card.tsx", before, after)).toBe([
      "--- a/card.tsx",
      "+++ b/card.tsx",
      "@@ -1,7 +1,7 @@",
      " one",
      " two",
      " three",
      "-four",
      "+FOUR",
      " five",
      " six",
      " seven",
      "",
    ].join("\n"));
  });

  it("renders a whole new source as pure additions", () => {
    expect(unifiedDiff("new.tsx", "", "alpha\nbeta")).toBe([
      "--- a/new.tsx",
      "+++ b/new.tsx",
      "@@ -0,0 +1,2 @@",
      "+alpha",
      "+beta",
      "",
    ].join("\n"));
  });

  it("renders a removed source as pure deletions", () => {
    expect(unifiedDiff("gone.tsx", "alpha\nbeta", "")).toBe([
      "--- a/gone.tsx",
      "+++ b/gone.tsx",
      "@@ -1,2 +0,0 @@",
      "-alpha",
      "-beta",
      "",
    ].join("\n"));
  });

  it("splits distant edits into separate hunks with bounded context", () => {
    const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
    const before = lines.join("\n");
    const changed = [...lines];
    changed[1] = "line 2 CHANGED";
    changed[27] = "line 28 CHANGED";
    const diff = unifiedDiff("far.tsx", before, changed.join("\n"));
    const hunkHeaders = diff.split("\n").filter((line) => line.startsWith("@@"));
    expect(hunkHeaders).toHaveLength(2);
    expect(diff).toContain("-line 2\n+line 2 CHANGED");
    expect(diff).toContain("-line 28\n+line 28 CHANGED");
    // No hunk should carry the untouched middle of the file.
    expect(diff).not.toContain(" line 15");
  });

  it("keeps hunk line counts consistent with hunk content", () => {
    const before = "a\nb\nc\nd\ne\nf\ng\nh";
    const after = "a\nb\nc\nX\ne\nf\nzzz\ng\nh";
    const diff = unifiedDiff("count.tsx", before, after);
    for (const header of diff.split("\n").filter((line) => line.startsWith("@@"))) {
      const match = /^@@ -\d+,(\d+) \+\d+,(\d+) @@$/.exec(header);
      expect(match).not.toBeNull();
    }
    const body = diff.split("\n").filter((line) => /^[ +-]/.test(line) && !line.startsWith("---") && !line.startsWith("+++"));
    const beforeCount = body.filter((line) => line.startsWith(" ") || line.startsWith("-")).length;
    const afterCount = body.filter((line) => line.startsWith(" ") || line.startsWith("+")).length;
    const headers = diff.split("\n").filter((line) => line.startsWith("@@"));
    const declaredBefore = headers.reduce((sum, header) => sum + Number(/-\d+,(\d+)/.exec(header)?.[1]), 0);
    const declaredAfter = headers.reduce((sum, header) => sum + Number(/\+\d+,(\d+)/.exec(header)?.[1]), 0);
    expect(beforeCount).toBe(declaredBefore);
    expect(afterCount).toBe(declaredAfter);
  });
});
