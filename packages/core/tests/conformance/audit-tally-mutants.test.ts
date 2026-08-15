import { describe, expect, it } from "vitest";
import { memoryStoreOps, storeOpsConformance } from "../../src/conformance/index.js";
import type { ConformanceCase } from "../../src/conformance/index.js";
import type { StoreOps } from "../../src/store.js";

/**
 * The two `audit.tally` cases, run against tallies that are WRONG — one broken
 * rule at a time.
 *
 * A grouped read is the easiest thing in this contract to ship dead: every
 * implementation of it returns rows that look exactly right, and the three ways
 * it actually goes wrong (an hour that never arrives, a group filed under the
 * wrong dimension, a count that is off) all still parse, still type-check, and
 * still render a chart. So the cases are only worth what they CATCH, and this
 * file is where that is proven: the shipped memory reference passes them, and
 * each mutant below fails the one assertion written for it.
 *
 * A test OF the cases, not of any shipped implementation — the same job
 * retention-pending.test.ts does for the two cases nothing serves yet.
 */

/** The reference tally, then one rule broken on the way out. Every mutant is
 *  post-processing on the honest answer, so nothing else about the reference
 *  changes and the case can only be failing for the reason named. */
function withBrokenTally(
  ops: StoreOps,
  broken: {
    /** The counts, mirrored across the answer: every row present, every label
     *  right, and the arithmetic silently swapped between groups. */
    reversesTheCounts?: true;
    /** The last bucket never arrives — an off-by-one on a window boundary,
     *  which is what a tally gets wrong when it gets anything wrong. */
    dropsTheLastBucket?: true;
    /** Every group filed under one decidedBy: the shape of a statement that
     *  grouped on a column it did not also select. */
    mislabelsDecidedBy?: true;
  },
): StoreOps {
  return {
    ...ops,
    audit: {
      ...ops.audit,
      async tally(query) {
        const rows = await ops.audit.tally(query);
        if (broken.reversesTheCounts === true) {
          const counts = rows.map((row) => row.count).reverse();
          return rows.map((row, index) => ({ ...row, count: counts[index]! }));
        }
        if (broken.dropsTheLastBucket === true) {
          const last = rows.at(-1)?.bucket;
          return rows.filter((row) => row.bucket !== last);
        }
        if (broken.mislabelsDecidedBy === true) {
          return rows.map((row) => ({ ...row, decidedBy: "rule" as const }));
        }
        return rows;
      },
    },
  };
}

const tallyCases = (make: () => StoreOps): ConformanceCase[] =>
  storeOpsConformance({ makeOps: async () => ({ ops: make() }) })
    .cases.filter((conformanceCase) => conformanceCase.name.startsWith("audit.tally"));

describe("the audit.tally cases catch a tally that is wrong", () => {
  it("carries both tally cases, and neither is pending — the reference serves the op", () => {
    const cases = tallyCases(() => memoryStoreOps());
    expect(cases).toHaveLength(2);
    expect(cases.every((conformanceCase) => conformanceCase.pending === undefined)).toBe(true);
  });

  for (const conformanceCase of tallyCases(() => memoryStoreOps())) {
    it(`passes against the honest reference: ${conformanceCase.name}`, async () => {
      await conformanceCase.run();
    });
  }

  // The message is asserted, not just the failure: a case that goes red for an
  // unrelated reason is not the same as a case that caught the thing it exists
  // for, and the three assertions are split precisely so these three mutants
  // land on three different ones.
  it("catches a tally whose counts are right in total but wrong per group", async () => {
    const [grouping] = tallyCases(() => withBrokenTally(memoryStoreOps(), { reversesTheCounts: true }));
    await expect(grouping!.run()).rejects.toThrow(/counted the wrong number of events in a group/);
  });

  it("catches a tally that drops a bucket the window holds", async () => {
    const [grouping] = tallyCases(() => withBrokenTally(memoryStoreOps(), { dropsTheLastBucket: true }));
    await expect(grouping!.run()).rejects.toThrow(/buckets are not the window's UTC hours/);
  });

  it("catches a tally that files every group under the wrong dimension", async () => {
    const [grouping] = tallyCases(() => withBrokenTally(memoryStoreOps(), { mislabelsDecidedBy: true }));
    await expect(grouping!.run()).rejects.toThrow(/labelled a group with the wrong outcome or decidedBy/);
  });

  // And the filter case has its own mutant: a tally that ignores the filters it
  // was given counts the whole drawer, which is a number that looks perfectly
  // reasonable next to a feed nobody cross-checked.
  it("catches a tally that ignores the filters the feed is narrowed by", async () => {
    const unfiltered = (ops: StoreOps): StoreOps => ({
      ...ops,
      audit: { ...ops.audit, tally: async (query) => ops.audit.tally({ from: query.from }) },
    });
    const [, filters] = tallyCases(() => unfiltered(memoryStoreOps()));
    await expect(filters!.run()).rejects.toThrow(/the tally counted \d+ events where the feed shows \d+/);
  });
});
