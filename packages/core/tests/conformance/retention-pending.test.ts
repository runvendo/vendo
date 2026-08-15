import { describe, expect, it } from "vitest";
import { memoryStoreOps, storeOpsConformance } from "../../src/conformance/index.js";
import type { ConformanceCase } from "../../src/conformance/index.js";
import type { IsoDateTime } from "../../src/ids.js";
import type { StoreOps, VendoRecord } from "../../src/store.js";

/**
 * The two `retention` cases are PENDING: the contract declares the family and
 * nothing ships one yet, so every mount carries them skipped with the lane that
 * owes them named in the output.
 *
 * A pending case nobody has ever executed is a paragraph of prose wearing a
 * test's clothes. It can assert the wrong contract, or nothing at all, and the
 * day the lane arrives the first thing it debugs is the case rather than the
 * code. So this file runs both of them against a reference `retention` built
 * here — proving they PASS against an implementation that honors the contract,
 * and, one broken rule at a time, that they FAIL against one that does not.
 *
 * This is the only place in the suite that executes a pending case. It is a
 * test OF the cases, not of any shipped implementation: `memoryStoreOps()`
 * still omits `retention`, and both cases stay skipped everywhere they mount.
 */

/** The contract's own words, in the smallest thing that can obey them:
 *  quarantine lifts rows out of the live collection and remembers WHEN it
 *  lifted them; purge destroys the lifted rows whose lift predates its cutoff.
 *  Built entirely on the public ops surface — the engine owns its quarantine,
 *  so even a reference may not reach past the doors to fake one. */
function withRetention(
  ops: StoreOps,
  broken: {
    countsRowsItDidNotMove?: true;
    leavesRowsLive?: true;
    ignoresTheGrace?: true;
  } = {},
): StoreOps {
  const quarantined = new Map<string, Array<{ record: VendoRecord; at: number }>>();
  return {
    ...ops,
    retention: {
      async quarantine(collection, olderThan) {
        const cutoff = Date.parse(olderThan);
        const live = await ops.engine.list(collection);
        const due = live.records.filter((record) => Date.parse(record.createdAt) < cutoff);
        const held = quarantined.get(collection) ?? [];
        for (const record of due) {
          if (broken.leavesRowsLive !== true) await ops.engine.delete(collection, record.id);
          held.push({ record, at: Date.now() });
        }
        quarantined.set(collection, held);
        // The honest count is what LEFT the live collection; a sweep that
        // reports the window's whole population instead is the mistake a cron
        // makes exactly once, on its second run.
        return { moved: broken.countsRowsItDidNotMove === true ? live.records.length : due.length };
      },
      async purge(collection, quarantinedBefore) {
        const cutoff = Date.parse(quarantinedBefore);
        const held = quarantined.get(collection) ?? [];
        const kept = broken.ignoresTheGrace === true ? [] : held.filter((row) => row.at >= cutoff);
        quarantined.set(collection, kept);
        return { purged: held.length - kept.length };
      },
    },
  };
}

const retentionCases = (make: () => StoreOps): ConformanceCase[] =>
  storeOpsConformance({ makeOps: async () => ({ ops: make() }) })
    .cases.filter((conformanceCase) => conformanceCase.pending !== undefined);

describe("the pending retention cases are executable contract", () => {
  const reference = retentionCases(() => withRetention(memoryStoreOps()));

  it("carries exactly the two retention cases, and carries them tagged", () => {
    expect(reference).toHaveLength(2);
    for (const conformanceCase of reference) {
      expect(conformanceCase.pending).toContain("the retention lane");
    }
  });

  for (const conformanceCase of reference) {
    it(`passes against a retention that honors the contract: ${conformanceCase.name}`, async () => {
      await conformanceCase.run();
    });
  }

  // Each of these breaks ONE rule the cases exist to hold, so a green result
  // here would mean the case is decorative. The message is asserted too: a case
  // that fails for an unrelated reason is not the same as a case that caught
  // the thing it was written for.
  it("catches a sweep that counts rows it never moved", async () => {
    const [quarantine] = retentionCases(() => withRetention(memoryStoreOps(), { countsRowsItDidNotMove: true }));
    await expect(quarantine!.run()).rejects.toThrow(/cutoff older than every row should move nothing/);
  });

  it("catches a sweep that reports rows moved but leaves them live", async () => {
    const [quarantine] = retentionCases(() => withRetention(memoryStoreOps(), { leavesRowsLive: true }));
    await expect(quarantine!.run()).rejects.toThrow(/quarantined rows stayed in the live collection/);
  });

  it("catches a purge that destroys rows still inside their recovery grace", async () => {
    const [, purge] = retentionCases(() => withRetention(memoryStoreOps(), { ignoresTheGrace: true }));
    await expect(purge!.run()).rejects.toThrow(/purge cutoff predating the sweep should destroy nothing/);
  });

  it("leaves the shipped memory reference without a retention family, so both stay skipped", async () => {
    expect(memoryStoreOps().retention).toBeUndefined();
    // And the cases no-op rather than fail on a mount that omits it — which is
    // what lets every mount carry them without going red.
    for (const conformanceCase of retentionCases(() => memoryStoreOps())) {
      await expect(conformanceCase.run()).resolves.toBeUndefined();
    }
  });
});

describe("a quarantine window is a cutoff, not a row rewrite", () => {
  // The cases can only write rows NOW, so the window has to be expressed by
  // moving the cutoff. This pins the reading both cases depend on: a row is
  // due when its OWN timestamp predates the cutoff.
  it("lifts only the rows whose createdAt predates the cutoff", async () => {
    const ops = withRetention(memoryStoreOps());
    const collection = "vendo_parked_call";
    await ops.engine.put(collection, { id: "old_1", data: {} });
    const between = new Date(Date.now() + 60_000).toISOString() as IsoDateTime;
    await ops.engine.put(collection, { id: "new_1", data: {} });

    const swept = await ops.retention!.quarantine(collection, between);
    expect(swept.moved).toBe(2);
    expect((await ops.engine.list(collection)).records).toHaveLength(0);
  });
});
