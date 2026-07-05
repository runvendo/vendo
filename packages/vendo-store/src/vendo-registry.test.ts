/**
 * DrizzleSavedVendoStore contract tests — durable port of the core
 * `SavedVendoStore` seam (packages/vendo-core/src/seams/store.ts).
 * Behavioral spec: InMemorySavedVendoStore
 * (packages/vendo-runtime/src/embedded/in-memory-store.ts).
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Principal, SavedVendo } from "@vendoai/core";
import { createVendoDatabase, migrateVendoDatabase, type VendoDb } from "./db.js";
import { createDrizzleSavedVendoStore } from "./vendo-registry.js";

const scope: Principal = { tenantId: "t1", subject: "u1" };
const other: Principal = { tenantId: "t1", subject: "u2" };

const draft: Omit<SavedVendo, "id" | "createdAt" | "updatedAt"> = {
  name: "Late-night spend",
  pinned: false,
  uiTree: { kind: "component", id: "n1", name: "Text", props: {} } as never,
  query: { toolName: "get_transactions", input: { limit: 40 } },
  originatingPrompt: "show my late-night spending",
};

let suffix = 0;
function uniqueDataDir(): string {
  suffix += 1;
  return `memory://vendo-registry-test-${Date.now()}-${suffix}`;
}

let handle: VendoDb;
let store: ReturnType<typeof createDrizzleSavedVendoStore>;
let tick = 0;

beforeAll(async () => {
  handle = await createVendoDatabase({ pglite: { dataDir: uniqueDataDir() } });
  await migrateVendoDatabase(handle);
});

beforeEach(async () => {
  await handle.db.execute(sql`truncate table vendo.saved_vendos`);
  tick = 0;
  store = createDrizzleSavedVendoStore(handle, {
    now: () => `2026-07-0${1 + (tick++ % 9)}T00:00:00.000Z`,
  });
});

describe("DrizzleSavedVendoStore", () => {
  it("save() assigns store-owned id + timestamps — caller never supplies them", async () => {
    const saved = await store.save(scope, draft);
    expect(saved.id).toBeTruthy();
    expect(saved.createdAt).toBeTruthy();
    expect(saved.updatedAt).toBeTruthy();
    expect(saved.name).toBe(draft.name);
  });

  it("get/list/delete are Principal-scoped", async () => {
    const saved = await store.save(scope, draft);
    await store.save(other, draft);
    expect(await store.get(other, saved.id)).toBeUndefined();
    expect((await store.list(scope)).map((f) => f.id)).toEqual([saved.id]);
    await store.delete(other, saved.id); // no-op outside scope
    expect(await store.list(scope)).toHaveLength(1);
    await store.delete(scope, saved.id);
    expect(await store.list(scope)).toHaveLength(0);
  });

  it("list() orders by updatedAt descending", async () => {
    const first = await store.save(scope, { ...draft, name: "first" });
    const second = await store.save(scope, { ...draft, name: "second" });
    const third = await store.save(scope, { ...draft, name: "third" });
    const list = await store.list(scope);
    expect(list.map((f) => f.id)).toEqual([third.id, second.id, first.id]);
  });

  it("get() returns undefined for an unknown id", async () => {
    expect(await store.get(scope, "nope")).toBeUndefined();
  });
});
