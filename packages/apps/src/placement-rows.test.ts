import { describe, expect, it } from "vitest";
import {
  PLACEMENTS_COLLECTION,
  PLACEMENT_SLOTS_COLLECTION,
  placementStore,
  type PlacementRow,
} from "./placements.js";
import { memoryStore } from "./testing/index.js";

const row = (slot: string, appId: string, placedAt = "2026-08-05T12:00:00.000Z"): PlacementRow =>
  ({ slot, appId, placedBy: "user_ada", placedAt });

describe("placementStore — one row per (subject, slot)", () => {
  it("puts, gets and deletes a row, keyed by the pair", async () => {
    const rows = placementStore(memoryStore());
    expect(await rows.get("user_ada", "home-hero")).toBeUndefined();

    await rows.put("user_ada", row("home-hero", "app_1"));
    expect(await rows.get("user_ada", "home-hero")).toEqual(row("home-hero", "app_1"));
    // Another subject's slot of the same name is a different row entirely.
    expect(await rows.get("user_mia", "home-hero")).toBeUndefined();

    // Scoped to the app that holds it: naming another one clears nothing.
    await rows.delete("user_ada", "home-hero", "app_2");
    expect(await rows.get("user_ada", "home-hero")).toEqual(row("home-hero", "app_1"));

    await rows.delete("user_ada", "home-hero", "app_1");
    expect(await rows.get("user_ada", "home-hero")).toBeUndefined();
  });

  it("a second place in the same slot REPLACES the row rather than adding one", async () => {
    const rows = placementStore(memoryStore());
    await rows.put("user_ada", row("home-hero", "app_1"));
    await rows.put("user_ada", row("home-hero", "app_2", "2026-08-05T13:00:00.000Z"));
    expect(await rows.list("user_ada")).toEqual([row("home-hero", "app_2", "2026-08-05T13:00:00.000Z")]);
  });

  it("lists a subject's rows, and only the asked-for slots when slots are named", async () => {
    const rows = placementStore(memoryStore());
    await rows.put("user_ada", row("home-hero", "app_1"));
    await rows.put("user_ada", row("sidebar", "app_2"));
    await rows.put("user_mia", row("home-hero", "app_3"));

    expect((await rows.list("user_ada")).map(({ slot }) => slot)).toEqual(["home-hero", "sidebar"]);
    expect(await rows.list("user_ada", ["sidebar"])).toEqual([row("sidebar", "app_2")]);
    // Unknown and duplicate slot names are dropped, never repeated.
    expect(await rows.list("user_ada", ["sidebar", "sidebar", "nope"])).toEqual([row("sidebar", "app_2")]);
  });

  it("writes the refs the erase cascade and the slot query read, on BOTH rows", async () => {
    const store = memoryStore();
    await placementStore(store).put("user_ada", row("home-hero", "app_1"));
    // The live row's id carries the placement's token, so it is found the way
    // the cascade finds it — by refs — rather than by a spelled-out id.
    const live = await store.records(PLACEMENTS_COLLECTION).list({ refs: { subject: "user_ada" } });
    expect(live.records.map((record) => record.refs))
      .toEqual([{ subject: "user_ada", slot: "home-hero", app_id: "app_1" }]);
    // The pointer is a row too, and an erase that missed it would leave a slot
    // pointing at a token whose live row is gone.
    const pointer = await store.records(PLACEMENT_SLOTS_COLLECTION).get("plc:user_ada:home-hero");
    expect(pointer?.refs).toEqual({ subject: "user_ada", slot: "home-hero", app_id: "app_1" });
  });

  it("clears every subject's placement of one app, not just one person's", async () => {
    // App deletion sweeps by app: a shared app sits in slots belonging to
    // people its owner cannot enumerate, and a row left behind is a failure
    // card standing on somebody else's page.
    const store = memoryStore();
    const rows = placementStore(store);
    await rows.put("user_ada", row("home-hero", "app_shared"));
    await rows.put("user_mia", row("sidebar", "app_shared"));
    await rows.put("user_mia", row("home-hero", "app_other"));

    await rows.clearForApp("app_shared");

    expect(await rows.list("user_ada")).toEqual([]);
    expect((await rows.list("user_mia")).map(({ slot }) => slot)).toEqual(["home-hero"]);
    // Nothing left behind on either side of the split.
    expect((await store.records(PLACEMENTS_COLLECTION).list({ refs: { app_id: "app_shared" } })).records)
      .toEqual([]);
    expect((await store.records(PLACEMENT_SLOTS_COLLECTION).list({ refs: { app_id: "app_shared" } })).records)
      .toEqual([]);
  });

  it("leaves exactly one live row per slot — the count the seam readers take", async () => {
    const store = memoryStore();
    const rows = placementStore(store);
    const live = async (): Promise<number> =>
      (await store.records(PLACEMENTS_COLLECTION).list({ refs: { subject: "user_ada" } })).records.length;

    await rows.put("user_ada", row("home-hero", "app_1"));
    expect(await live()).toBe(1);
    await rows.put("user_ada", row("home-hero", "app_2"));
    expect(await live()).toBe(1);
    await rows.delete("user_ada", "home-hero", "app_2");
    expect(await live()).toBe(0);
  });

  it("keeps ':' inside a subject or slot from shifting the pair", async () => {
    const rows = placementStore(memoryStore());
    await rows.put("a:b", row("c", "app_1"));
    await rows.put("a", row("b:c", "app_2"));
    expect((await rows.get("a:b", "c"))?.appId).toBe("app_1");
    expect((await rows.get("a", "b:c"))?.appId).toBe("app_2");
  });
});
