import { describe, expect, it } from "vitest";
import { aggregateRetrievalMetrics, recallAtK, reciprocalRank, type RetrievalOutcome } from "./metrics.js";

/** T2 — retrieval math pinned exactly: known ranks → known values. */

describe("recallAtK", () => {
  it("counts expected docs inside the top k", () => {
    expect(recallAtK(["a"], ["a", "b", "c"], 5)).toBe(1);
    expect(recallAtK(["a"], ["b", "c"], 5)).toBe(0);
    expect(recallAtK(["a", "b"], ["a", "x", "y"], 5)).toBe(0.5);
    expect(recallAtK(["a", "b"], ["a", "x", "y", "z", "q", "b"], 5)).toBe(0.5);
    expect(recallAtK(["a"], ["x", "y", "z", "q", "a"], 5)).toBe(1);
  });

  it("an empty expectation earns full credit (nothing to judge)", () => {
    expect(recallAtK([], ["a"], 5)).toBe(1);
  });
});

describe("reciprocalRank", () => {
  it("is 1/rank of the first expected doc", () => {
    expect(reciprocalRank(["a"], ["a", "b"])).toBe(1);
    expect(reciprocalRank(["a"], ["b", "a"])).toBe(0.5);
    expect(reciprocalRank(["a", "b"], ["x", "b", "a"])).toBe(0.5);
    expect(reciprocalRank(["a"], ["x", "y", "z", "a"])).toBe(0.25);
  });

  it("is 0 when nothing expected is retrieved", () => {
    expect(reciprocalRank(["a"], ["x", "y"])).toBe(0);
    expect(reciprocalRank(["a"], [])).toBe(0);
  });
});

describe("aggregateRetrievalMetrics", () => {
  const outcome = (
    itemId: string,
    intent: RetrievalOutcome["intent"],
    expected: string[],
    ranked: string[],
  ): RetrievalOutcome => ({ itemId, intent, expectedDocIds: expected, rankedDocIds: ranked });

  it("means recall and MRR overall and per intent that has items", () => {
    const metrics = aggregateRetrievalMetrics(
      [
        outcome("i1", "chat", ["a"], ["a"]),        // recall 1, rr 1
        outcome("i2", "chat", ["b"], ["x", "b"]),   // recall 1, rr 0.5
        outcome("i3", "schema", ["c"], ["x", "y"]), // recall 0, rr 0
      ],
      5,
    );
    expect(metrics["recall@5"]).toBeCloseTo(2 / 3, 6);
    expect(metrics.mrr).toBeCloseTo(0.5, 6);
    expect(metrics["recall@5.chat"]).toBe(1);
    expect(metrics["mrr.chat"]).toBe(0.75);
    expect(metrics["recall@5.schema"]).toBe(0);
    expect(metrics["mrr.schema"]).toBe(0);
    expect(metrics["recall@5.deep"]).toBeUndefined();
    expect(metrics["mrr.deep"]).toBeUndefined();
  });
});
