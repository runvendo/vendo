/**
 * FINAL SPEC v1 — "Sharing of built apps: refused SERVER-SIDE on every path
 * (share, fork, export, placement) via one artifact-kind policy check."
 *
 * Driven through the real runtime doors, never through the predicate: a client
 * that skips the SDK still hits these four, and a predicate nobody calls
 * refuses nothing. The tree half is the other side of the same claim — screens
 * stay shareable exactly as before.
 */
import { engineOverAdapter } from "@vendoai/core";
import type { RunContext, ToolRegistry } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import type { AppDocument } from "../src/contract/index.js";
import { createApps, type AppsRuntime } from "../src/server/index.js";
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

const HASH = "a".repeat(64);

const tree: AppDocument = { format: "vendo/app@1", id: "app_tree", name: "Spending", ui: "tree" };
const built: AppDocument = {
  format: "vendo/app@1",
  id: "app_built",
  name: "Sequencer",
  ui: "bundle",
  bundle: { entry: HASH, bytes: 4096, sealedAt: "2026-08-24T00:00:00.000Z" },
};

const runtimeWith = async (...docs: AppDocument[]): Promise<AppsRuntime> => {
  const store = memoryStore();
  const engine = engineOverAdapter(store);
  for (const document of docs) await seedAppRow(engine, document, ctx.principal.subject);
  return createApps({
    store,
    guard: guardFixture(),
    tools,
    catalog: [],
    cloud: {
      share: async (_appId, doc) => ({ id: "share_1", doc, createdAt: "2026-08-24T00:00:00.000Z" }),
      publish: async (appId) => ({ id: "publish_1", appId, version: "1", createdAt: "2026-08-24T00:00:00.000Z" }),
    },
  });
};

/** The four shipped server-side doors, each named the way the refusal names it. */
const doors = (apps: AppsRuntime, appId: string) => ({
  shared: () => apps.share(appId, ctx),
  forked: () => apps.fork(appId, ctx),
  exported: () => apps.exportApp(appId, ctx),
  "placed in a slot": () => apps.place({ app: appId, slot: "home-hero" }, ctx),
});

describe("a built app is not shareable", () => {
  it("refuses share, fork, export and place for a sealed bundle", async () => {
    const apps = await runtimeWith(built);

    for (const [operation, attempt] of Object.entries(doors(apps, "app_built"))) {
      await expect(attempt()).rejects.toMatchObject({
        code: "blocked",
        message: `a built app cannot be ${operation}: its bundle would run someone else's code with the`
          + " recipient's own permissions, and that seam ships with its own consent story — only screens"
          + " travel today",
      });
    }
    // Refused BEFORE the write: the place door never reached the row.
    expect(await apps.placements({}, ctx)).toEqual([]);
  });

  it("refuses a half-written row that carries only one of the two bundle signals", async () => {
    const noUi = await runtimeWith({ ...built, id: "app_no_ui", ui: undefined });
    const noSeal = await runtimeWith({ ...built, id: "app_no_seal", bundle: undefined });

    await expect(noUi.fork("app_no_ui", ctx)).rejects.toMatchObject({ code: "blocked" });
    await expect(noSeal.fork("app_no_seal", ctx)).rejects.toMatchObject({ code: "blocked" });
  });

  it("still shares, forks, exports and places a tree app", async () => {
    const apps = await runtimeWith(tree);

    await expect(apps.share("app_tree", ctx)).resolves.toMatchObject({ id: "share_1" });
    await expect(apps.fork("app_tree", ctx)).resolves.toMatchObject({ forkedFrom: "app_tree" });
    expect((await apps.exportApp("app_tree", ctx)).byteLength).toBeGreaterThan(0);
    expect(await apps.place({ app: "app_tree", slot: "home-hero" }, ctx)).toEqual({});
    expect(await apps.placements({}, ctx)).toEqual([
      { slot: "home-hero", app: "app_tree", title: "Spending", status: "ready" },
    ]);
  });
});
