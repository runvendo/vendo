/**
 * `meta` helper tests — the tiny operational KV (scheduler heartbeat, future
 * flags). One PGlite instance migrated once per file; TRUNCATE in beforeEach.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createFlowletDatabase, migrateFlowletDatabase, type FlowletDb } from "./db.js";
import { getMeta, setMeta } from "./meta.js";

let handle: FlowletDb;

beforeAll(async () => {
  handle = await createFlowletDatabase({
    pglite: { dataDir: `memory://meta-test-${Date.now()}` },
  });
  await migrateFlowletDatabase(handle);
});

beforeEach(async () => {
  await handle.db.execute(sql`truncate table flowlet.meta`);
});

describe("meta helpers", () => {
  it("getMeta on a miss resolves undefined", async () => {
    expect(await getMeta(handle, "scheduler_heartbeat")).toBeUndefined();
  });

  it("setMeta then getMeta roundtrips, and re-setting upserts", async () => {
    await setMeta(handle, "scheduler_heartbeat", { at: "2026-07-04T00:00:00.000Z" });
    expect(await getMeta(handle, "scheduler_heartbeat")).toEqual({ at: "2026-07-04T00:00:00.000Z" });

    await setMeta(handle, "scheduler_heartbeat", { at: "2026-07-04T00:01:00.000Z" });
    expect(await getMeta(handle, "scheduler_heartbeat")).toEqual({ at: "2026-07-04T00:01:00.000Z" });
  });
});
