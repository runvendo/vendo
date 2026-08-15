import { describe, expect, it } from "vitest";
import { STORE_WIRE_APPEND_MESSAGES_OPS, type StoreOps } from "../../src/index.js";
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
    // The reference now serves every family the suite covers — retention and
    // the batch append included — so nothing is carried unrun. The accounting
    // is asserted rather than the number: a case that is in none of the three
    // buckets is a case the report lost, which is exactly the blindness the
    // buckets exist to remove.
    expect(report.pending).toEqual(suite.cases.filter((c) => c.pending !== undefined).map((c) => c.name));
    // The reference serves ONE tenant, so the tenancy case is the only
    // omission. Pinned as a set rather than a count: an early `return` in any
    // other case would land here silently otherwise, which is the whole failure
    // the bucket exists to expose.
    expect(report.omitted.map((one) => one.name)).toEqual(["a neighbouring tenant shares no drawer with this one"]);
    expect(report.omitted[0]!.reason).toContain("one tenant");
    expect(report.passed + report.pending.length + report.omitted.length).toBe(suite.cases.length);
  });

  /** The omission bucket earning its keep: a mount that drops the OPTIONAL
      batch-append family is still `ok` — the contract allows the omission — but
      every case over it is counted as omitted rather than passed, so "this
      mount has no batch append" can never again read as "this mount's batch
      append is correct". Before the bucket existed those cases returned early
      and the report called them passes. */
  it("a mount that omits the batch append is counted, not quietly passed", async () => {
    const report = await runConformance(storeOpsConformance({
      async makeOps() {
        const ops = memoryStoreOps();
        return {
          ops: {
            ...ops,
            transcripts: { ...ops.transcripts, appendMessages: undefined },
            // A mount that omits op 36 may not claim to have reached it — the
            // status case pins that biconditional, and this mount is honest.
            async status() {
              return { ...(await ops.status()), ops: STORE_WIRE_APPEND_MESSAGES_OPS - 1 };
            },
          },
        };
      },
    }));
    expect(report.ok).toBe(true);
    const omittedNames = report.omitted.map((one) => one.name);
    expect(omittedNames.filter((name) => name.includes("appendMessages")).length).toBeGreaterThanOrEqual(6);
    for (const one of report.omitted) {
      if (one.name.includes("appendMessages")) expect(one.reason).toContain("omits transcripts.appendMessages");
    }
  });

  /** The same guarantee for the OTHER optional family, which the retention lane
      just landed an engine for: a BYO adapter with nowhere to quarantine to
      still leaves `retention` off, and both cases over it must then be counted
      rather than pass on an empty body. */
  it("a mount that omits the retention family is counted, not quietly passed", async () => {
    const report = await runConformance(storeOpsConformance({
      async makeOps() {
        return { ops: { ...memoryStoreOps(), retention: undefined } };
      },
    }));
    expect(report.ok).toBe(true);
    const retention = report.omitted.filter((one) => one.name.startsWith("retention."));
    expect(retention).toHaveLength(2);
    for (const one of retention) expect(one.reason).toContain("omits the retention family");
  });

  it("a deleteThread that leaves harness state behind fails conformance", async () => {
    const report = await runConformance(storeOpsConformance({
      makeOps: async () => ({ ops: partialCascade() }),
    }));
    expect(report.ok).toBe(false);
    expect(report.failures.map((failure) => failure.name).join("\n")).toContain("cascades");
  });
});
