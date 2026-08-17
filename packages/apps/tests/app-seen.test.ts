/**
 * The arrival seam. The mark goes in through the real door (`runtime.seen`) and
 * comes back out of the real read (`runtime.list`), over a real store — nothing
 * is stubbed on either side, so the writer and the reader cannot agree on a
 * shape neither of them actually uses.
 */
import { engineOverAdapter } from "@vendoai/core";
import type { RunContext, ToolRegistry } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import type { AppDocument } from "../src/contract/index.js";
import { createApps } from "../src/server/index.js";
import { APP_SEEN_COLLECTION } from "../src/server/persistence/app-seen.js";
import { guardFixture } from "../src/server/testing/guard-fixture.js";
import { memoryStore } from "../src/server/testing/memory-store.js";
import { seedAppRow } from "../src/server/testing/seed-app-row.js";

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
});
