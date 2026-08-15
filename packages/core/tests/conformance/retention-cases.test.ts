import { describe, expect, it } from "vitest";
import { memoryStoreOps, storeOpsConformance } from "../../src/conformance/index.js";
import type { ConformanceCase } from "../../src/conformance/index.js";
import type { IsoDateTime } from "../../src/ids.js";
import type { StoreOps } from "../../src/store.js";

/**
 * The two `retention` cases, held to being able to FAIL.
 *
 * They were carried as `pending` for one release — the contract declared the
 * family and nothing served it — and this file was what kept them from being a
 * paragraph of prose wearing a test's clothes: it executed them against a
 * reference before any engine existed. The family ships now (the memory
 * reference here, the local engine in @vendoai/store), so the cases run
 * everywhere the suite mounts, and what is left to prove is the half a green
 * suite never shows: that each case catches the thing it was written for.
 *
 * So every implementation below breaks ONE rule of the shipped memory
 * retention, and the case that owns that rule must go red — with ITS message,
 * because a case that fails for an unrelated reason is not the same as a case
 * that caught what it was for.
 */

const retentionCases = (make: () => StoreOps): ConformanceCase[] =>
  storeOpsConformance({ makeOps: async () => ({ ops: make() }) })
    .cases.filter((conformanceCase) => conformanceCase.name.startsWith("retention."));

/** One broken rule at a time, wrapped around the SHIPPED retention rather than
 *  a second implementation of it — so these proofs bind to the code that runs,
 *  not to a copy that can quietly drift away from it. */
function broken(
  rule: "countsRowsItDidNotMove" | "leavesRowsLive" | "ignoresTheGrace",
): StoreOps {
  const ops = memoryStoreOps();
  const retention = ops.retention!;
  return {
    ...ops,
    retention: {
      async quarantine(collection, olderThan) {
        // The window's whole population, not what left it — the mistake a cron
        // makes exactly once, on its second run.
        if (rule === "countsRowsItDidNotMove") {
          const live = await ops.engine.list(collection);
          await retention.quarantine(collection, olderThan);
          return { moved: live.records.length };
        }
        // Reported as moved, still readable: a sweep that copies instead of
        // lifting.
        if (rule === "leavesRowsLive") {
          const live = await ops.engine.list(collection);
          const moved = await retention.quarantine(collection, olderThan);
          for (const record of live.records) await ops.engine.put(collection, record);
          return moved;
        }
        return await retention.quarantine(collection, olderThan);
      },
      async purge(collection, quarantinedBefore) {
        // Destroys rows still inside their recovery grace — which turns the two
        // verbs back into the one DELETE they exist to not be.
        const cutoff = rule === "ignoresTheGrace"
          ? new Date(Date.now() + 3_600_000).toISOString() as IsoDateTime
          : quarantinedBefore;
        return await retention.purge(collection, cutoff);
      },
    },
  };
}

describe("the retention cases catch what they were written for", () => {
  it("carries both of them, and carries them RUNNING", () => {
    const cases = retentionCases(memoryStoreOps);
    expect(cases).toHaveLength(2);
    // Not `pending` any more: the family ships, so a mount that serves it is
    // held to these two, and re-tagging them would take that back silently.
    for (const conformanceCase of cases) expect(conformanceCase.pending).toBeUndefined();
  });

  it("catches a sweep that counts rows it never moved", async () => {
    const [quarantine] = retentionCases(() => broken("countsRowsItDidNotMove"));
    await expect(quarantine!.run()).rejects.toThrow(/cutoff older than every row should move nothing/);
  });

  it("catches a sweep that reports rows moved but leaves them live", async () => {
    const [quarantine] = retentionCases(() => broken("leavesRowsLive"));
    await expect(quarantine!.run()).rejects.toThrow(/quarantined rows stayed in the live collection/);
  });

  it("catches a purge that destroys rows still inside their recovery grace", async () => {
    const [, purge] = retentionCases(() => broken("ignoresTheGrace"));
    await expect(purge!.run()).rejects.toThrow(/purge cutoff predating the sweep should destroy nothing/);
  });

  // The family is OPTIONAL (01 §12), so neither case may fail a mount that
  // omits it — but neither may PASS one either, which is what a bare `return`
  // used to do. Both report the omission instead, and `runConformance` counts
  // it in its own bucket, so "this engine has nowhere to quarantine to" can
  // never read as "this engine's sweep is correct".
  it("reports an omission, not a pass, on a mount that omits the family entirely", async () => {
    for (const conformanceCase of retentionCases(() => ({ ...memoryStoreOps(), retention: undefined }))) {
      await expect(conformanceCase.run()).resolves.toEqual({
        omitted: expect.stringContaining("omits the retention family"),
      });
    }
  });
});

describe("a quarantine window is a cutoff, not a row rewrite", () => {
  // The cases can only write rows NOW, so the window has to be expressed by
  // moving the cutoff. This pins the reading both cases depend on: a row is
  // due when its OWN timestamp predates the cutoff.
  it("lifts only the rows whose createdAt predates the cutoff", async () => {
    const ops = memoryStoreOps();
    const collection = "vendo_parked_call";
    await ops.engine.put(collection, { id: "old_1", data: {} });
    const between = new Date(Date.now() + 60_000).toISOString() as IsoDateTime;
    await ops.engine.put(collection, { id: "new_1", data: {} });

    const swept = await ops.retention!.quarantine(collection, between);
    expect(swept.moved).toBe(2);
    expect((await ops.engine.list(collection)).records).toHaveLength(0);
  });
});
