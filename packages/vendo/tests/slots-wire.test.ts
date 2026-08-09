// The slot registry's two routes, driven through the real route table: which
// slots a host's surfaces mount is reported by the surfaces themselves, so the
// write and the read are the same seam and are proved together here.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal } from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo } from "../src/server.js";

const principal: Principal = { kind: "user", subject: "user_slots" };

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-slots-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

const request = (method: string, path: string, body?: unknown): Request =>
  new Request(`https://host.test/api/vendo${path}`, {
    method,
    headers: method === "POST" ? { "content-type": "application/json" } : {},
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("POST /slots · GET /slots", () => {
  it("round-trips a page's reported slots, and a renamed label lands in place", async () => {
    const store = await tempStore();
    const vendo = createVendo({ principal: async () => principal, store });

    const reported = await vendo.handler(request("POST", "/slots", {
      slots: [{ id: "hero", label: "Homepage hero" }, { id: "sidebar", label: "Sidebar" }],
    }));
    expect(reported.status).toBe(200);
    expect(await reported.json()).toEqual({});

    const listed = await vendo.handler(request("GET", "/slots"));
    expect(listed.status).toBe(200);
    const slots = await listed.json() as { id: string; label: string; lastSeen: string }[];
    expect(slots.map(({ id, label }) => ({ id, label })).sort((a, b) => a.id.localeCompare(b.id)))
      .toEqual([{ id: "hero", label: "Homepage hero" }, { id: "sidebar", label: "Sidebar" }]);
    expect(slots.every(({ lastSeen }) => Number.isFinite(Date.parse(lastSeen)))).toBe(true);

    // Reporting again is the steady state — every render does it — so it must
    // update rather than accumulate, all the way through the wire.
    await vendo.handler(request("POST", "/slots", { slots: [{ id: "hero", label: "Hero banner" }] }));
    const again = await (await vendo.handler(request("GET", "/slots"))).json() as { id: string; label: string }[];
    // Two rows still, the newly seen one first.
    expect(again.map(({ id }) => id)).toEqual(["hero", "sidebar"]);
    expect(again[0]).toMatchObject({ label: "Hero banner" });
  });

  it("refuses a body that is not a list of {id, label}", async () => {
    const store = await tempStore();
    const vendo = createVendo({ principal: async () => principal, store });

    for (const body of [{ slots: "hero" }, { slots: [{ id: "hero" }] }, { slots: [null] }]) {
      const response = await vendo.handler(request("POST", "/slots", body));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "validation" } });
    }
  });

  it("is not mounted at all when the deployment set apps: false", async () => {
    const store = await tempStore();
    const vendo = createVendo({ principal: async () => principal, store, apps: false });

    expect((await vendo.handler(request("GET", "/slots"))).status).toBe(404);
    expect((await vendo.handler(request("POST", "/slots", { slots: [] }))).status).toBe(404);
  });

  it("refuses a request the host resolved no identity for", async () => {
    const store = await tempStore();
    const vendo = createVendo({ principal: async () => null, store });

    const response = await vendo.handler(request("GET", "/slots"));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "forbidden" } });
  });
});
