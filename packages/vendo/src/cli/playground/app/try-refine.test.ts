import { describe, expect, it } from "vitest";
import {
  approvedIds,
  classifyDiffLine,
  projectRefineRun,
  refineEnabled,
  refineErrorMessage,
  toggleDecision,
  type RefineDecision,
} from "./try-refine.js";

describe("refineEnabled", () => {
  it("renders the affordance ONLY on capabilities.refine === true (selectSurfaceMode's strictness)", () => {
    expect(refineEnabled({ capabilities: { liveChat: true, refine: true } } as never)).toBe(true);
    expect(refineEnabled({ capabilities: { liveChat: true, refine: false } } as never)).toBe(false);
    expect(refineEnabled({ capabilities: { refine: "yes" } } as never)).toBe(false);
    expect(refineEnabled({} as never)).toBe(false);
    expect(refineEnabled(null)).toBe(false);
  });
});

describe("classifyDiffLine", () => {
  it("classifies the whole-file diff dialect: headers meta, +/- tinted, everything else context", () => {
    expect(classifyDiffLine("--- a/.vendo/overrides.json")).toBe("meta");
    expect(classifyDiffLine("+++ b/.vendo/overrides.json")).toBe("meta");
    expect(classifyDiffLine('+  "disabled": true')).toBe("add");
    expect(classifyDiffLine('-  "disabled": false')).toBe("del");
    expect(classifyDiffLine("unchanged")).toBe("context");
    expect(classifyDiffLine("")).toBe("context");
  });
});

describe("projectRefineRun", () => {
  const wire = {
    runId: "run_1",
    changes: [
      { id: 0, file: ".vendo/overrides.json", summary: "Tool corrections", diff: "+x", warnings: ["risk DOWNGRADE proposed"] },
    ],
    dropped: [{ kind: "compound", target: "x", reason: "invalid" }],
    probes: [],
  };

  it("projects the server response into review cards", () => {
    expect(projectRefineRun(wire)).toEqual({
      runId: "run_1",
      cards: [{ id: 0, file: ".vendo/overrides.json", summary: "Tool corrections", diff: "+x", warnings: ["risk DOWNGRADE proposed"] }],
      dropped: 1,
    });
  });

  it("tolerates absent optional fields (summary falls back to the file, junk warnings dropped)", () => {
    const run = projectRefineRun({ runId: "run_2", changes: [{ id: 0, file: "f", diff: "d", warnings: [1, "real"] }] });
    expect(run).toEqual({ runId: "run_2", cards: [{ id: 0, file: "f", summary: "f", diff: "d", warnings: ["real"] }], dropped: 0 });
  });

  it("rejects malformed responses whole — null, never a half-rendered review", () => {
    expect(projectRefineRun(null)).toBeNull();
    expect(projectRefineRun("nope")).toBeNull();
    expect(projectRefineRun({ runId: "", changes: [] })).toBeNull();
    expect(projectRefineRun({ runId: "run_3", changes: [{ id: "0", file: "f", diff: "d" }] })).toBeNull();
    expect(projectRefineRun({ runId: "run_3", changes: "x" })).toBeNull();
  });
});

describe("decisions", () => {
  it("toggleDecision flips between verdicts and re-pressing clears back to undecided", () => {
    let decisions: Record<number, RefineDecision> = {};
    decisions = toggleDecision(decisions, 0, "approved");
    expect(decisions).toEqual({ 0: "approved" });
    decisions = toggleDecision(decisions, 0, "dismissed");
    expect(decisions).toEqual({ 0: "dismissed" });
    decisions = toggleDecision(decisions, 0, "dismissed");
    expect(decisions).toEqual({});
  });

  it("approvedIds returns only approved card ids, ascending", () => {
    expect(approvedIds({ 2: "approved", 0: "dismissed", 1: "approved" })).toEqual([1, 2]);
    expect(approvedIds({})).toEqual([]);
  });
});

describe("refineErrorMessage", () => {
  it("surfaces the server's own error message when it sent one", () => {
    expect(refineErrorMessage(409, { error: { code: "refine-busy", message: "a refine run is already in flight" } }))
      .toBe("a refine run is already in flight");
  });

  it("falls back to an honest HTTP-status line, never a fake success", () => {
    expect(refineErrorMessage(503, null)).toBe("Refine failed (HTTP 503).");
    expect(refineErrorMessage(500, { error: { message: "  " } })).toBe("Refine failed (HTTP 500).");
  });
});
