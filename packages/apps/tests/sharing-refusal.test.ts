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
import type { FilesAdapter, RunContext, ToolRegistry } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import type { AppBuilder, AppDocument } from "../src/contract/index.js";
import { createApps, type AppsConfig, type AppsRuntime } from "../src/server/index.js";
import { guardFixture } from "../src/server/testing/guard-fixture.js";
import { memoryStore } from "../src/server/testing/memory-store.js";
import { seedAppRow } from "../src/server/testing/seed-app-row.js";
import { storeAccessFixture } from "./app-access-fixture.js";

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

/**
 * The path a PERSON's share actually takes: the ✦ toggle calls
 * `client.apps.share` → `PUT /apps/:id/grants/:principal` → `access.grant`,
 * never `AppsRuntime.share`. Org-held with an admin caller because core refuses
 * a person-to-person grant on a still-personal app, so that is the only world
 * in which the allowed half can land.
 */
const grantWorld = async (document: AppDocument, extra: Partial<AppsConfig> = {}) => {
  const store = memoryStore();
  const guard = guardFixture();
  await seedAppRow(engineOverAdapter(store), document, "acme");
  return {
    store,
    guard,
    apps: createApps({
      store,
      guard,
      tools,
      catalog: [],
      appAccess: storeAccessFixture(store),
      ...extra,
    }),
    admin: { ...ctx, memberships: [{ org: "acme", admin: true }] } satisfies RunContext,
  };
};

/** The shipped server-side doors, each named the way the refusal names it. */
const doors = (apps: AppsRuntime, appId: string) => ({
  shared: () => apps.share(appId, ctx),
  published: () => apps.publish(appId, ctx),
  forked: () => apps.fork(appId, ctx),
  exported: () => apps.exportApp(appId, ctx),
  "placed in a slot": () => apps.place({ app: appId, slot: "home-hero" }, ctx),
});

describe("a built app is not shareable", () => {
  it("refuses share, publish, fork, export and place for a sealed bundle", async () => {
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

  it("refuses the ✦ share toggle, which is a grant and not `share`", async () => {
    const { apps, admin } = await grantWorld(built);

    await expect(apps.access.grant("app_built", "user:bob", "viewer", admin)).rejects.toMatchObject({
      code: "blocked",
      message: expect.stringContaining("a built app cannot be shared"),
    });
    // Refused BEFORE the write: no grant row reached the seam.
    expect(await apps.access.list("app_built", admin)).toEqual([]);
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

  it("still grants a tree app to another principal", async () => {
    const { apps, admin } = await grantWorld(tree);

    await expect(apps.access.grant("app_tree", "user:bob", "viewer", admin))
      .resolves.toMatchObject([{ principal: "user:bob", level: "viewer" }]);
  });
});

/**
 * The window between the person's yes and the seal — minutes, and observed real
 * builds ran 229–450s. A row that declared itself a bundle only AT the seal
 * carried neither signal for all of it, so every refusal above let a grant
 * through, and the grant survived the seal.
 *
 * Real all the way down: the real propose door, the real guard decision, the
 * real `onApprovalDecision` resume, the real row, and the real grant seam
 * `PUT /apps/:id/grants/:principal` calls. Only the box stands in — and it never
 * comes back, which IS the window.
 */
describe("a build that has started is already a built app", () => {
  const files: FilesAdapter = {
    async put() {},
    async get() { return undefined; },
    async delete() {},
  };
  /** The box, still working. Nothing ever resolves this. */
  const stillInTheBox: AppBuilder = { available: () => true, build: () => new Promise(() => {}) };

  /** One consented build, driven to whatever the box does next. */
  const consented = async (appId: string, build: AppBuilder) => {
    const world = await grantWorld({ ...tree, id: "app_seed" }, { files, build });
    const proposed = await world.apps.build.propose(
      { appId, name: "Sequencer", prompt: "a step sequencer", why: "needs a real audio library" },
      world.admin,
    );
    if (!("approvalId" in proposed)) throw new Error(`the build was declined: ${proposed.declined}`);
    world.guard.decide(proposed.approvalId, true);
    await new Promise((resolve) => setImmediate(resolve));
    const row = await world.store.records("vendo_apps").get(appId);
    return { ...world, doc: (row?.data as { doc: AppDocument } | undefined)?.doc };
  };

  it("refuses the ✦ share toggle while the consented build is still in the box", async () => {
    const { apps, admin, doc } = await consented("app_seed", stillInTheBox);

    // The window, observed on the row: a box is being spent right now, and
    // nothing is sealed yet.
    expect(doc?.building).toEqual(expect.any(String));
    expect(doc?.bundle).toBeUndefined();

    await expect(apps.access.grant("app_seed", "user:bob", "viewer", admin)).rejects.toMatchObject({
      code: "blocked",
      message: expect.stringContaining("a built app cannot be shared"),
    });
    // Refused BEFORE the write: no grant row reached the seam, so there is
    // nothing for the seal to hand over minutes later.
    expect(await apps.access.list("app_seed", admin)).toEqual([]);
  });

  it("strands no row claiming to be a bundle when the first build fails", async () => {
    const { doc } = await consented("app_first_build", {
      available: () => true,
      build: async () => ({ kind: "failed", why: "the box died" }),
    });

    // `markUnbuilt` REPLACES the row, so the kind stamped on the way in goes
    // with it: a failed first build leaves the honest failure card, never an app
    // that says it is a bundle and has none.
    expect(doc?.ui).toBeUndefined();
    expect(doc?.bundle).toBeUndefined();
    expect(doc?.buildFailed).toMatchObject({ reason: "the box died" });
  });

  it("still grants a tree app whose SCREEN build is mid-flight", async () => {
    // The row a screen save writes while its assembler is still running
    // (write-surface.ts:228 stamps `building` onto the `ui: "tree"` it writes at
    // :231) — normal screens, and refusing on `building` alone would take them.
    const { apps, admin } = await grantWorld({ ...tree, building: "2026-08-24T00:00:00.000Z" });

    await expect(apps.access.grant("app_tree", "user:bob", "viewer", admin))
      .resolves.toMatchObject([{ principal: "user:bob", level: "viewer" }]);
  });
});
