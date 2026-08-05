import { describe, expect, it } from "vitest";
import { VendoError, appDocumentSchema, threadIdSchema, type StoreOps } from "../index.js";
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

/** A backend that validates reserved writes the way real stores do (the
    memory reference skips this): thread ids must match `^thr_.+$` and
    `vendo_apps` data must be a full app payload. The suite's own fixtures have
    to survive both, or conforming schema-validating backends fail for reasons
    unrelated to their behavior. */
const schemaValidating = (): StoreOps => {
  const ops = memoryStoreOps();
  return {
    ...ops,
    records: {
      ...ops.records,
      async put(collection, input) {
        if (collection === "vendo_apps") {
          const data = input.data as Record<string, unknown> | null | undefined;
          if (typeof data?.["subject"] !== "string") throw new VendoError("validation", "app subject must be a string");
          if (typeof data["enabled"] !== "boolean") throw new VendoError("validation", "app enabled must be a boolean");
          if (!appDocumentSchema.safeParse(data["doc"]).success) throw new VendoError("validation", "app document: Invalid");
        }
        return ops.records.put(collection, input);
      },
    },
    transcripts: {
      ...ops.transcripts,
      async putThread(thread) {
        if (!threadIdSchema.safeParse(thread.id).success) throw new VendoError("validation", "thread id: Invalid");
        return ops.transcripts.putThread(thread);
      },
    },
  };
};

/** Deep-copies with each object's key insertion order reversed; arrays keep
    their order. Same key/value pairs, so semantically the same JSON. */
const reverseKeys = <T>(value: T): T => {
  if (Array.isArray(value)) return value.map(reverseKeys) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).reverse().map(([k, v]) => [k, reverseKeys(v)]),
    ) as T;
  }
  return value;
};

/** A backend that reconstructs read records with a different key insertion
    order than the put echo — conformance must compare canonically, not by
    serialized key order. */
const keyOrderScrambling = (): StoreOps => {
  const ops = memoryStoreOps();
  return {
    ...ops,
    records: {
      ...ops.records,
      async get(collection, id) {
        return reverseKeys(await ops.records.get(collection, id));
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

  it("passes against a schema-validating backend — fixtures use thr_ thread ids and valid app seeds", async () => {
    const report = await runConformance(storeOpsConformance({
      makeOps: async () => ({ ops: schemaValidating() }),
    }));
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("accepts a backend whose reads reorder object keys — equality is canonical, not insertion-order", async () => {
    const report = await runConformance(storeOpsConformance({
      makeOps: async () => ({ ops: keyOrderScrambling() }),
    }));
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
