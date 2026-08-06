// The fixture wire's placement half — asserted directly, because every slot and
// picker test in this PR reads and writes through it. A fixture that lies makes
// every test above it meaningless.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createVendoClient, type VendoClient } from "../src/index.js";
import { createWireServer } from "./wire-server.js";

describe("fixture wire — placements", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeEach(async () => {
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
  });

  afterEach(async () => {
    await wire.close();
  });

  it("reports a placed, servable app as ready with its title", async () => {
    await client.apps.place("app_1", "hero");
    expect(await client.apps.placements()).toEqual([
      { slot: "hero", app: "app_1", title: "Invoices", status: "ready" },
    ]);
  });

  it("reports an id with no servable record yet as building", async () => {
    await client.apps.place("app_minting", "hero");
    const [entry] = await client.apps.placements(["hero"]);
    expect(entry?.status).toBe("building");
  });

  it("reports a terminally failed build as failed", async () => {
    wire.state.failedApps.set("app_doomed", { reason: "quota exhausted" });
    await client.apps.place("app_doomed", "hero");
    const [entry] = await client.apps.placements(["hero"]);
    expect(entry?.status).toBe("failed");
  });

  it("lands a building app after its poll window, in place", async () => {
    wire.state.landingApps.set("app_lands", { after: 2, seen: 0, name: "Trip planner" });
    await client.apps.place("app_lands", "hero");
    expect((await client.apps.placements(["hero"]))[0]?.status).toBe("building");
    expect((await client.apps.placements(["hero"]))[0]).toEqual({
      slot: "hero", app: "app_lands", title: "Trip planner", status: "ready",
    });
  });

  it("filters to the slots asked for", async () => {
    await client.apps.place("app_1", "hero");
    await client.apps.place("app_1", "sidebar");
    expect((await client.apps.placements(["sidebar"])).map(entry => entry.slot)).toEqual(["sidebar"]);
  });

  it("evicts the app already in the slot and reports which one", async () => {
    await client.apps.place("app_1", "hero");
    expect(await client.apps.place("app_auto", "hero")).toEqual({ evicted: "app_1" });
    const [entry] = await client.apps.placements(["hero"]);
    expect(entry?.app).toBe("app_auto");
  });

  it("unplace clears the row", async () => {
    await client.apps.place("app_1", "hero");
    await client.apps.unplace("app_1", "hero");
    expect(await client.apps.placements()).toEqual([]);
  });

  it("serves a rung-4 app as the http surface kind", async () => {
    wire.state.httpApps.set("app_1", "/frame-target.html");
    expect(await client.apps.open("app_1")).toEqual({ kind: "http", url: "/frame-target.html" });
  });
});
