/**
 * The arrival seam. The mark goes in through the real door (`runtime.seen`) and
 * comes back out of the real read (`runtime.list`), over a real store — nothing
 * is stubbed on either side, so the writer and the reader cannot agree on a
 * shape neither of them actually uses.
 */
import { engineOverAdapter, setLogger } from "@vendoai/core";
import type { RunContext, StoreAdapter, ToolRegistry, VendoLogEvent } from "@vendoai/core";
import { afterEach, describe, expect, it } from "vitest";
import type { AppDocument } from "../src/contract/index.js";
import { createApps } from "../src/server/index.js";
import { APP_SEEN_COLLECTION } from "../src/server/persistence/app-seen.js";
import { guardFixture } from "../src/server/testing/guard-fixture.js";
import { memoryStore } from "../src/server/testing/memory-store.js";
import { seedAppRow } from "../src/server/testing/seed-app-row.js";

afterEach(() => {
  setLogger(undefined);
});

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_ada" },
  venue: "app",
  presence: "present",
  sessionId: "session_ada",
};

const tools: ToolRegistry = {
  async descriptors() { return []; },
  async execute() { return { status: "error", error: { code: "not-found", message: "no tools" } }; },
};

const doc = (id: string, name: string): AppDocument => ({
  format: "vendo/app@1",
  id,
  name,
  ui: "tree",
  tree: {
    formatVersion: "vendo-genui/v2",
    root: "root",
    nodes: [{ id: "root", component: "Stack", source: "prewired" }],
  },
});

/** Make one collection refuse everything, the way an engine allowlist does. */
function refuseSeenRows(store: StoreAdapter): void {
  const records = store.records.bind(store);
  const refused = (): Error =>
    Object.assign(new Error(`${APP_SEEN_COLLECTION} is not enabled for this deployment`), {
      name: "VendoError",
      code: "blocked",
    });
  store.records = (collection) => collection !== APP_SEEN_COLLECTION ? records(collection) : {
    async get() { throw refused(); },
    async put() { throw refused(); },
    async delete() { throw refused(); },
    async list() { throw refused(); },
  };
}

describe("app arrival", () => {
  it("marks one app seen and leaves the other unseen in the list", async () => {
    const store = memoryStore();
    const engine = engineOverAdapter(store);
    await seedAppRow(engine, doc("app_1", "Spending"), ctx.principal.subject);
    await seedAppRow(engine, doc("app_2", "Travel"), ctx.principal.subject);
    const runtime = createApps({ store, guard: guardFixture(), tools, catalog: [] });
    // Read as a map: `list` orders by recency, which is not what this is about.
    const unseenByApp = async () =>
      Object.fromEntries((await runtime.list(ctx)).map((app) => [app.id, app.unseen === true]));

    expect(await unseenByApp()).toEqual({ app_1: true, app_2: true });

    await runtime.seen("app_1", ctx);

    expect(await unseenByApp()).toEqual({ app_1: false, app_2: true });
  });

  it("takes every person's read state with the app when it is deleted", async () => {
    const store = memoryStore();
    const engine = engineOverAdapter(store);
    await seedAppRow(engine, doc("app_1", "Spending"), ctx.principal.subject);
    const runtime = createApps({ store, guard: guardFixture(), tools, catalog: [] });
    await runtime.seen("app_1", ctx);
    const rows = async () => (await store.records(APP_SEEN_COLLECTION).list({})).records.length;

    expect(await rows()).toBe(1);

    await runtime.delete("app_1", ctx);

    // Not "the deleter's rows": a shared app was seen by people the owner
    // cannot enumerate, and an id that can never come back must leave none.
    expect(await rows()).toBe(0);
  });

  /** A store may refuse this collection outright: Vendo Cloud's engine allowlist
   *  did not carry `vendo_app_seen` in 0.27.0. The refusal wears the shape a
   *  SECOND `@vendoai/core` copy mints (a host bundle's dist/cjs), which is what
   *  carried it past `instanceof VendoError` everywhere it passed. */
  it("a store that will not hold read state costs the DOT, never the answer", async () => {
    const logs: VendoLogEvent[] = [];
    setLogger((event) => { logs.push(event); });
    const store = memoryStore();
    const engine = engineOverAdapter(store);
    await seedAppRow(engine, doc("app_1", "Spending"), ctx.principal.subject);
    refuseSeenRows(store);
    const runtime = createApps({ store, guard: guardFixture(), tools, catalog: [] });

    // The refusal used to travel out of `list` and take the whole page of apps
    // with it, and out of `seen` on every render of every app.
    const apps = await runtime.list(ctx);
    expect(apps.map((app) => app.id)).toEqual(["app_1"]);
    expect(apps[0]?.unseen).toBeUndefined();
    await expect(runtime.seen("app_1", ctx)).resolves.toBeUndefined();

    // Once for the process, however many renders ask.
    expect(logs.filter((event) => event.code === "apps.app-seen-unavailable")).toHaveLength(1);
  });
});
