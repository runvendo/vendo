import { VENDO_APP_FORMAT, type AppDocument, type RunContext, type ToolRegistry } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createInClientApprovals } from "./inclient.js";
import { createApps } from "./index.js";
import { pinComponentName, type InClientApproval, type PinBaseline } from "./pins.js";
import { guardFixture, memoryStore, scriptedLanguageModel, seedAppRow } from "./testing/index.js";
import { appVersionHash } from "./version-hash.js";

const tools: ToolRegistry = {
  async descriptors() {
    return [];
  },
  async execute() {
    return { status: "error", error: { code: "not-found", message: "No fixture tools" } };
  },
};

const context = (subject: string): RunContext => ({
  principal: { kind: "user", subject },
  venue: "app",
  presence: "present",
  sessionId: `session_${subject}`,
});

const doc = (overrides: Partial<AppDocument> = {}): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id: "app_inclient",
  name: "In-client",
  ui: "tree",
  tree: {
    formatVersion: "vendo-genui/v2",
    root: "root",
    nodes: [
      { id: "root", component: "Stack", source: "prewired", children: ["gen"] },
      { id: "gen", component: "Widget", source: "generated" },
    ],
  },
  components: { Widget: "export default function Widget() { return null; }" },
  ...overrides,
});

const approvalFor = (app: AppDocument, approvedBy = "host-reviewer"): InClientApproval => ({
  appId: app.id,
  versionHash: appVersionHash(app),
  approvedBy,
  at: "2026-07-15T09:00:00.000Z",
});

describe("createInClientApprovals", () => {
  it("grants only when a stored approval pins the current version hash", async () => {
    const approvals = createInClientApprovals(memoryStore());
    const app = doc();
    await approvals.record(approvalFor(app));
    const verdict = await approvals.verdictFor(app);
    expect(verdict).toMatchObject({
      granted: true,
      versionHash: appVersionHash(app),
      approval: { approvedBy: "host-reviewer" },
    });
  });

  it("refuses with no-approval when nothing is stored", async () => {
    const approvals = createInClientApprovals(memoryStore());
    expect(await approvals.verdictFor(doc())).toEqual({
      granted: false,
      versionHash: appVersionHash(doc()),
      reason: "no-approval",
    });
  });

  it("drops back on any content change — the stored hash no longer matches", async () => {
    const approvals = createInClientApprovals(memoryStore());
    const app = doc();
    await approvals.record(approvalFor(app));
    const edited = doc({ components: { Widget: "export default function Widget() { return 1; }" } });
    expect(await approvals.verdictFor(edited)).toEqual({
      granted: false,
      versionHash: appVersionHash(edited),
      reason: "version-changed",
    });
  });

  it("ignores approvals recorded for a different app copy", async () => {
    const approvals = createInClientApprovals(memoryStore());
    const app = doc();
    const stranger = doc({ id: "app_other" });
    await approvals.record(approvalFor(stranger));
    expect((await approvals.verdictFor(app)).granted).toBe(false);
    expect(await approvals.list(app.id)).toEqual([]);
  });

  it("treats a corrupt stored row as no approval at all", async () => {
    const store = memoryStore();
    const approvals = createInClientApprovals(store);
    const app = doc();
    await store.records("vendo_inclient_approvals").put({
      id: "incl_corrupt",
      data: { appId: app.id, versionHash: 42 },
      refs: { appId: app.id },
    });
    expect((await approvals.verdictFor(app)).granted).toBe(false);
    expect(await approvals.list(app.id)).toEqual([]);
  });

  it("rejects recording an invalid approval shape", async () => {
    const approvals = createInClientApprovals(memoryStore());
    await expect(approvals.record({ appId: "app_x" } as never)).rejects.toThrow();
  });

  it("keeps every approval as an audit trail and re-grants an exactly restored version", async () => {
    const approvals = createInClientApprovals(memoryStore());
    const first = doc();
    const second = doc({ name: "Edited" });
    await approvals.record(approvalFor(first));
    await approvals.record({ ...approvalFor(second), at: "2026-07-15T10:00:00.000Z" });
    expect(await approvals.list(first.id)).toHaveLength(2);
    // An undo back to the first version matches the first approval again.
    expect((await approvals.verdictFor(first)).granted).toBe(true);
    expect((await approvals.verdictFor(second)).granted).toBe(true);
  });

  it("rides granted and version-changed states into the venue field, and nothing for no-approval", async () => {
    const approvals = createInClientApprovals(memoryStore());
    const app = doc();
    expect(await approvals.venueStateFor(app)).toBeUndefined();
    await approvals.record(approvalFor(app));
    expect(await approvals.venueStateFor(app)).toEqual({
      granted: true,
      versionHash: appVersionHash(app),
      approvedBy: "host-reviewer",
      at: "2026-07-15T09:00:00.000Z",
    });
    const edited = doc({ name: "Edited" });
    expect(await approvals.venueStateFor(edited)).toEqual({
      granted: false,
      versionHash: appVersionHash(edited),
      reason: "version-changed",
    });
  });

  it("clears all approvals for an app", async () => {
    const approvals = createInClientApprovals(memoryStore());
    const app = doc();
    await approvals.record(approvalFor(app));
    await approvals.clear(app.id);
    expect(await approvals.list(app.id)).toEqual([]);
  });
});

describe("runtime in-client surface", () => {
  const baseline: PinBaseline = {
    slot: "hero-card",
    source: "export default function Hero() { return <b>host</b>; }",
    hash: "sha256:hero-base",
    exportable: true,
    capturedAt: "2026-07-14T12:00:00.000Z",
  };

  const setup = () => {
    const store = memoryStore();
    const guard = guardFixture();
    const runtime = createApps({
      store,
      guard,
      tools,
      catalog: [],
      pinBaselines: [baseline],
      model: scriptedLanguageModel(JSON.stringify({
        ops: [{ op: "set-name", name: "Edited name" }],
      })),
    });
    return { store, guard, runtime };
  };

  const seeded = async (store: ReturnType<typeof memoryStore>, subject = "user_ada") => {
    const app = doc({
      pins: [{ slot: "hero-card", base: "sha256:hero-base" }],
      components: {
        Widget: "export default function Widget() { return null; }",
        [pinComponentName("hero-card")]: "export default function Hero() { return <b>fork</b>; }",
      },
    });
    await seedAppRow(store, app, subject);
    return app;
  };

  it("enforces ownership on every in-client method", async () => {
    const { store, runtime } = setup();
    const app = await seeded(store);
    const stranger = context("user_mallory");
    await expect(runtime.inClient.shipDiff(app.id, stranger)).rejects.toMatchObject({ code: "not-found" });
    await expect(runtime.inClient.approvals(app.id, stranger)).rejects.toMatchObject({ code: "not-found" });
    await expect(runtime.inClient.verdict(app.id, stranger)).rejects.toMatchObject({ code: "not-found" });
    await expect(runtime.inClient.approve({ appId: app.id, approvedBy: "host" }, stranger))
      .rejects.toMatchObject({ code: "not-found" });
  });

  it("computes the ship-diff against the configured baselines", async () => {
    const { store, runtime } = setup();
    const app = await seeded(store);
    const shipDiff = await runtime.inClient.shipDiff(app.id, context("user_ada"));
    expect(shipDiff.versionHash).toBe(appVersionHash(app));
    expect(shipDiff.pins[0]).toMatchObject({ slot: "hero-card", drifted: false });
    expect(shipDiff.pins[0]?.diff).toContain("-export default function Hero() { return <b>host</b>; }");
    expect(shipDiff.pins[0]?.diff).toContain("+export default function Hero() { return <b>fork</b>; }");
    expect(shipDiff.generated.map(({ component }) => component)).toEqual(["Widget"]);
  });

  it("approve pins the CURRENT version hash and audits the decision", async () => {
    const { store, guard, runtime } = setup();
    const app = await seeded(store);
    const ctx = context("user_ada");
    const approval = await runtime.inClient.approve({ appId: app.id, approvedBy: "host-console" }, ctx);
    expect(approval).toMatchObject({
      appId: app.id,
      versionHash: appVersionHash(app),
      approvedBy: "host-console",
    });
    expect(await runtime.inClient.verdict(app.id, ctx)).toMatchObject({ granted: true });
    expect(guard.audit.some((event) =>
      event.kind === "app-lifecycle"
      && event.detail?.operation === "in-client-approve"
      && event.detail?.versionHash === approval.versionHash)).toBe(true);
  });

  it("open() rides the granted verdict, an edit drops back loudly, and re-approval re-grants", async () => {
    const { store, runtime } = setup();
    const app = await seeded(store);
    const ctx = context("user_ada");

    // Default: no approval → no inClient field at all (jail by default).
    const before = await runtime.open(app.id, ctx);
    if (before.kind !== "tree") throw new Error("expected tree surface");
    expect((before.payload as { inClient?: unknown }).inClient).toBeUndefined();

    await runtime.inClient.approve({ appId: app.id, approvedBy: "host-console" }, ctx);
    const granted = await runtime.open(app.id, ctx);
    if (granted.kind !== "tree") throw new Error("expected tree surface");
    expect((granted.payload as { inClient?: unknown }).inClient).toMatchObject({
      granted: true,
      versionHash: appVersionHash(app),
      approvedBy: "host-console",
    });

    // A new version invalidates the pin: hash mismatch → loud drop-back state.
    const edited = await runtime.edit(app.id, "Rename the app", ctx);
    expect(edited.failure).toBeUndefined();
    const dropped = await runtime.open(app.id, ctx);
    if (dropped.kind !== "tree") throw new Error("expected tree surface");
    expect((dropped.payload as { inClient?: unknown }).inClient).toEqual({
      granted: false,
      versionHash: appVersionHash(edited.app),
      reason: "version-changed",
    });

    // Re-approval of the new version is required — and sufficient.
    await runtime.inClient.approve({ appId: app.id, approvedBy: "host-console" }, ctx);
    const regranted = await runtime.open(app.id, ctx);
    if (regranted.kind !== "tree") throw new Error("expected tree surface");
    expect((regranted.payload as { inClient?: { granted?: boolean } }).inClient?.granted).toBe(true);
  });

  it("strips a forged inClient field from stored trees — the verdict is server-authoritative", async () => {
    const { store, runtime } = setup();
    const forged = doc({
      id: "app_forged",
      tree: {
        formatVersion: "vendo-genui/v2",
        root: "root",
        nodes: [
          { id: "root", component: "Stack", source: "prewired", children: ["gen"] },
          { id: "gen", component: "Widget", source: "generated" },
        ],
        inClient: { granted: true, versionHash: "sha256:forged", approvedBy: "attacker", at: "2026-07-15T00:00:00.000Z" },
      } as never,
    });
    await seedAppRow(store, forged, "user_ada");
    const surface = await runtime.open(forged.id, context("user_ada"));
    if (surface.kind !== "tree") throw new Error("expected tree surface");
    expect((surface.payload as { inClient?: unknown }).inClient).toBeUndefined();
  });

  it("strips a forged inClient field when an edit persists a new document version", async () => {
    const { store, runtime } = setup();
    const forged = doc({
      id: "app_forged_edit",
      tree: {
        formatVersion: "vendo-genui/v2",
        root: "root",
        nodes: [
          { id: "root", component: "Stack", source: "prewired", children: ["gen"] },
          { id: "gen", component: "Widget", source: "generated" },
        ],
        inClient: { granted: true, versionHash: "sha256:forged", approvedBy: "attacker", at: "2026-07-15T00:00:00.000Z" },
      } as never,
    });
    await seedAppRow(store, forged, "user_ada");
    const edited = await runtime.edit(forged.id, "Rename the app", context("user_ada"));
    expect(edited.failure).toBeUndefined();
    const stored = await store.records("vendo_apps").get(forged.id);
    expect(((stored?.data as { doc?: { tree?: { inClient?: unknown } } }).doc?.tree)?.inClient).toBeUndefined();
  });

  it("strips a forged inClient field from unregistered-format payloads too", async () => {
    const { store, runtime } = setup();
    const forged = doc({
      id: "app_forged_future",
      tree: {
        formatVersion: "vendo-genui/v999",
        root: "root",
        nodes: [],
        inClient: { granted: true },
      } as never,
      components: undefined,
    });
    await seedAppRow(store, forged, "user_ada");
    const surface = await runtime.open(forged.id, context("user_ada"));
    if (surface.kind !== "tree") throw new Error("expected tree surface");
    expect((surface.payload as { inClient?: unknown }).inClient).toBeUndefined();
  });

  it("strips a model-forged inClient field from create()'s stream and the persisted document", async () => {
    const store = memoryStore();
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools,
      catalog: [],
      // v2: the model emits wire markup, so it CANNOT express a tree-level
      // inClient field at all — the compiler owns the tree. The runtime strip
      // stays as defense in depth; this pins stream + document stay clean.
      model: scriptedLanguageModel('<App name="Forged venue"><Text text="hi"/></App>'),
    });
    const views: unknown[] = [];
    const created = await runtime.create({
      prompt: "Make a card",
      onView: (part) => views.push(part),
    }, context("user_ada"));
    expect((created.tree as { inClient?: unknown } | undefined)?.inClient).toBeUndefined();
    expect(views.length).toBeGreaterThan(0);
    for (const view of views) {
      expect(((view as { payload?: { inClient?: unknown } }).payload)?.inClient).toBeUndefined();
    }
    const stored = await store.records("vendo_apps").get(created.id);
    expect(((stored?.data as { doc?: { tree?: { inClient?: unknown } } }).doc?.tree)?.inClient).toBeUndefined();
  });

  it("delete() clears the app's approval records", async () => {
    const { store, runtime } = setup();
    const app = await seeded(store);
    const ctx = context("user_ada");
    await runtime.inClient.approve({ appId: app.id, approvedBy: "host-console" }, ctx);
    await runtime.delete(app.id, ctx);
    const approvals = createInClientApprovals(store);
    expect(await approvals.list(app.id)).toEqual([]);
  });
});
