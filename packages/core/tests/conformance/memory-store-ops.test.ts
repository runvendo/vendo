import { describe, expect, it } from "vitest";
import type { StoreOps } from "../../src/index.js";
import { memoryStoreOps, runConformance, storeOpsConformance } from "../../src/conformance/index.js";

/** A backend whose thread delete drops the thread row and puts the thread's
    harness state back — exactly the partial cascade F4 exists to catch. */
const partialCascade = (): StoreOps => {
  const ops = memoryStoreOps();
  return {
    ...ops,
    transcripts: {
      ...ops.transcripts,
      async deleteThread(id) {
        const thread = await ops.transcripts.getThread(id);
        const subject = (thread?.data as { subject?: string } | undefined)?.subject;
        const slot = `harness_state:${id}`;
        const orphan = subject === undefined ? null : await ops.harness.get(slot, subject);
        await ops.transcripts.deleteThread(id);
        if (subject !== undefined && orphan !== null) await ops.harness.set(slot, subject, orphan);
      },
    },
  };
};

describe("StoreOps conformance kit against the memory reference", () => {
  const suite = storeOpsConformance({ makeOps: async () => ({ ops: memoryStoreOps() }) });

  it("mounts at least one case per op", () => {
    expect(suite.seam).toBe("StoreOps");
    expect(suite.cases.length).toBeGreaterThanOrEqual(28);
  });

  // A pending case is carried, not run — and it is SKIPPED WITH ITS REASON in
  // the name, so an op the contract declares and nothing serves yet is a line
  // in the test output rather than an absence nobody can see.
  for (const conformanceCase of suite.cases) {
    if (conformanceCase.pending === undefined) it(conformanceCase.name, conformanceCase.run);
    else it.skip(`${conformanceCase.name} [pending: ${conformanceCase.pending}]`, conformanceCase.run);
  }

  it("runConformance reports ok for the memory reference, and names what is pending", async () => {
    const report = await runConformance(suite);
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
    // The reference serves no retention family, so the two cases over it must
    // be reported as pending rather than passed — a green report that counted
    // them as passes is exactly the blindness the tag exists to remove.
    expect(report.pending.length).toBe(suite.cases.filter((c) => c.pending !== undefined).length);
    expect(report.passed + report.pending.length).toBe(suite.cases.length);
  });

  it("a deleteThread that leaves harness state behind fails conformance", async () => {
    const report = await runConformance(storeOpsConformance({
      makeOps: async () => ({ ops: partialCascade() }),
    }));
    expect(report.ok).toBe(false);
    expect(report.failures.map((failure) => failure.name).join("\n")).toContain("cascades");
  });
});
