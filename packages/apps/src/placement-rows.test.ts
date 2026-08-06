import { describe, expect, it } from "vitest";
import { placementStore, type PlacementRow } from "./placements.js";
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

    await rows.delete("user_ada", "home-hero");
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

  it("writes the refs the erase cascade and the slot query read", async () => {
    const store = memoryStore();
    await placementStore(store).put("user_ada", row("home-hero", "app_1"));
    const record = await store.records("vendo_placements").get("plc:user_ada:home-hero");
    expect(record?.refs).toEqual({ subject: "user_ada", slot: "home-hero" });
  });

  it("keeps ':' inside a subject or slot from shifting the pair", async () => {
    const rows = placementStore(memoryStore());
    await rows.put("a:b", row("c", "app_1"));
    await rows.put("a", row("b:c", "app_2"));
    expect((await rows.get("a:b", "c"))?.appId).toBe("app_1");
    expect((await rows.get("a", "b:c"))?.appId).toBe("app_2");
  });
});
