/**
 * DrizzleDecisionStore contract tests — implements the runtime `DecisionStore`
 * seam (packages/flowlet-runtime/src/policy/remember.ts): async get/set by an
 * opaque canonical key. One PGlite instance migrated once per file; TRUNCATE
 * in beforeEach for a clean slate.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Principal } from "@flowlet/core";
import { createFlowletDatabase, migrateFlowletDatabase, type FlowletDb } from "./db.js";
import { createDrizzleDecisionStore } from "./decision-store.js";

const alice: Principal = { tenantId: "tenant-1", subject: "alice" };
const bob: Principal = { tenantId: "tenant-1", subject: "bob" };

let suffix = 0;
function uniqueDataDir(): string {
  suffix += 1;
  return `memory://decision-store-test-${Date.now()}-${suffix}`;
}

let handle: FlowletDb;

beforeAll(async () => {
  handle = await createFlowletDatabase({ pglite: { dataDir: uniqueDataDir() } });
  await migrateFlowletDatabase(handle);
});

beforeEach(async () => {
  await handle.db.execute(sql`truncate table flowlet.decisions`);
});

describe("DrizzleDecisionStore", () => {
  it("get() on a miss resolves undefined", async () => {
    const store = createDrizzleDecisionStore(handle, alice);
    expect(await store.get("some-key")).toBeUndefined();
  });

  it("set() then get() roundtrips the decision", async () => {
    const store = createDrizzleDecisionStore(handle, alice);
    await store.set("k1", "approve");
    expect(await store.get("k1")).toBe("approve");
  });

  it("set() on an existing key upserts (overwrites) rather than erroring", async () => {
    const store = createDrizzleDecisionStore(handle, alice);
    await store.set("k1", "approve");
    await store.set("k1", "approve");
    expect(await store.get("k1")).toBe("approve");
  });

  it("scope isolation: alice's decision is invisible to bob under the same key", async () => {
    const aliceStore = createDrizzleDecisionStore(handle, alice);
    const bobStore = createDrizzleDecisionStore(handle, bob);
    await aliceStore.set("shared-key", "approve");
    expect(await bobStore.get("shared-key")).toBeUndefined();
    expect(await aliceStore.get("shared-key")).toBe("approve");
  });
});
