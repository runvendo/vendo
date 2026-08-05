import { describe, expect, it } from "vitest";
import type { StoreOps } from "../index.js";
import { memoryStoreOps, runConformance, storeOpsConformance } from "./index.js";

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
    expect(suite.cases.length).toBeGreaterThanOrEqual(32);
  });

  for (const conformanceCase of suite.cases) {
    it(conformanceCase.name, conformanceCase.run);
  }

  it("runConformance reports ok for the memory reference", async () => {
    const report = await runConformance(suite);
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("a deleteThread that leaves harness state behind fails conformance", async () => {
    const report = await runConformance(storeOpsConformance({
      makeOps: async () => ({ ops: partialCascade() }),
    }));
    expect(report.ok).toBe(false);
    expect(report.failures.map((failure) => failure.name).join("\n")).toContain("cascades");
  });
});
