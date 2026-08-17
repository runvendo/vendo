import { engineOverAdapter } from "@vendoai/core";
import {
  type RunContext,
  type ToolRegistry,
} from "@vendoai/core";
import {
  type AppDocument,
} from "../src/contract/index.js";
import { describe, expect, it } from "vitest";
import { createInClientApprovals } from "../src/server/remix/inclient.js";
import { createApps, type AppsRuntime } from "../src/server/index.js";
import { SCREEN_FILE, type SeedBaseline } from "../src/contract/index.js";
import type { InClientApproval } from "../src/server/index.js";
import { authoringAssembler, scriptedAssembler } from "../src/server/testing/screen-assembler.js";
import { guardFixture } from "../src/server/testing/guard-fixture.js";
import { memoryStore } from "../src/server/testing/memory-store.js";
import { basicLanguageModel } from "../src/server/testing/scripted-model.js";
import { screenDocument } from "../src/server/testing/screen-document.js";
import { seedAppRow } from "../src/server/testing/seed-app-row.js";
import { inlineSourceFile } from "../src/server/persistence/app-source.js";
import { appVersionHash } from "../src/server/remix/version-hash.js";

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

const doc = (overrides: Partial<AppDocument> = {}): AppDocument =>
  screenDocument("app_inclient", {
    name: "In-client",
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
    const approvals = createInClientApprovals(engineOverAdapter(memoryStore()));
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
    const approvals = createInClientApprovals(engineOverAdapter(memoryStore()));
    expect(await approvals.verdictFor(doc())).toEqual({
      granted: false,
      versionHash: appVersionHash(doc()),
      reason: "no-approval",
    });
  });

  it("drops back on any content change — the stored hash no longer matches", async () => {
    const approvals = createInClientApprovals(engineOverAdapter(memoryStore()));
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
    const approvals = createInClientApprovals(engineOverAdapter(memoryStore()));
    const app = doc();
    const stranger = doc({ id: "app_other" });
    await approvals.record(approvalFor(stranger));
    expect((await approvals.verdictFor(app)).granted).toBe(false);
    expect(await approvals.list(app.id)).toEqual([]);
  });

  it("treats a corrupt stored row as no approval at all", async () => {
    const store = memoryStore();
    const approvals = createInClientApprovals(engineOverAdapter(store));
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
    const approvals = createInClientApprovals(engineOverAdapter(memoryStore()));
    await expect(approvals.record({ appId: "app_x" } as never)).rejects.toThrow();
  });

  it("keeps every approval as an audit trail and re-grants an exactly restored version", async () => {
    const approvals = createInClientApprovals(engineOverAdapter(memoryStore()));
    const first = doc();
    const second = doc({ name: "Edited" });
    await approvals.record(approvalFor(first));
    await approvals.record({ ...approvalFor(second), at: "2026-07-15T10:00:00.000Z" });
    expect(await approvals.list(first.id)).toHaveLength(2);
    // Each version matches its own approval, and both stay matched.
    expect((await approvals.verdictFor(first)).granted).toBe(true);
    expect((await approvals.verdictFor(second)).granted).toBe(true);
  });

  it("rides granted and version-changed states into the venue field, and nothing for no-approval", async () => {
    const approvals = createInClientApprovals(engineOverAdapter(memoryStore()));
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
    const approvals = createInClientApprovals(engineOverAdapter(memoryStore()));
    const app = doc();
    await approvals.record(approvalFor(app));
    await approvals.clear(app.id);
    expect(await approvals.list(app.id)).toEqual([]);
  });
});

describe("runtime in-client surface", () => {
  const baseline: SeedBaseline = {
    slot: "hero-card",
    source: "export default function Hero() { return <b>host</b>; }",
    hash: "sha256:hero-base",
    exportable: true,
    capturedAt: "2026-07-14T12:00:00.000Z",
  };

  const setup = () => {
    const store = memoryStore();
    const guard = guardFixture();
    let runtime: AppsRuntime;
    runtime = createApps({
      store,
      guard,
      tools,
      catalog: [],
      seedBaselines: [baseline],
      model: basicLanguageModel(),
      // A rename through the ONE engine: the assembler opens the app, rewrites
      // it under the instruction's name and saves the whole thing through the
      // real `authoredScreen` write — which is exactly what makes this a NEW
      // version and drops the hash-pinned approval.
      screen: scriptedAssembler(() => runtime, ({ request }) => {
        // An EDIT's brief leads with the app's memory block, so the ask is its last line.
        const said = request.split("\n").map((line) => line.trim()).filter((line) => line !== "").at(-1) ?? "";
        const words = said.replace(/[^A-Za-z0-9]+/gu, " ").trim().split(" ");
        const name = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join("") || "Renamed";
        return `import { Stack, Text } from "@vendo/screen";

export default function ${name}() {
  return (
    <Stack gap={12}>
      <Text text="Renamed" variant="heading" />
    </Stack>
  );
}
`;
      }),
    });
    return { store, guard, runtime };
  };

  const seeded = async (store: ReturnType<typeof memoryStore>, subject = "user_ada") => {
    const app = doc({ seed: { component: "hero-card", baseline: "sha256:hero-base", instruction: "make it mine" } });
    await seedAppRow(engineOverAdapter(store), app, subject);
    return app;
  };

  it("enforces ownership on every in-client method", async () => {
    const { store, runtime } = setup();
    const app = await seeded(store);
    const stranger = context("user_mallory");
    await expect(runtime.inClient.shipDiff(app.id, stranger)).rejects.toMatchObject({ code: "not-found" });
    // The verdict reaches a caller on the open() payload and nowhere else, so
    // that is the door the masking has to hold on.
    await expect(runtime.open(app.id, stranger)).rejects.toMatchObject({ code: "not-found" });
    await expect(runtime.inClient.approve({ appId: app.id, approvedBy: "host" }, stranger))
      .rejects.toMatchObject({ code: "not-found" });
  });

  it("computes the ship-diff against the configured baselines", async () => {
    const { store, runtime } = setup();
    // A remix as it really is: its own screen, standing in for the host
    // component the seed names.
    const app = doc({
      seed: { component: "hero-card", baseline: "sha256:hero-base", instruction: "make it mine" },
      source: { [SCREEN_FILE]: inlineSourceFile("export default function Hero() { return <b>fork</b>; }") },
    });
    await seedAppRow(engineOverAdapter(store), app, "user_ada");
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
    const surface = await runtime.open(app.id, ctx);
    if (surface.kind !== "tree") throw new Error("expected tree surface");
    expect((surface.payload as { inClient?: unknown }).inClient).toMatchObject({ granted: true });
    expect(guard.audit.some((event) =>
      event.kind === "app-lifecycle"
      && (event.detail as { operation?: string } | undefined)?.operation === "in-client-approve"
      && (event.detail as { versionHash?: string } | undefined)?.versionHash === approval.versionHash)).toBe(true);
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

  it("keeps a model-forged inClient field out of create()'s streamed views", async () => {
    const store = memoryStore();
    let runtime: AppsRuntime;
    runtime = createApps({
      store,
      guard: guardFixture(),
      tools,
      catalog: [],
      model: basicLanguageModel(),
      // An author writes a component screen, so it CANNOT express a payload-level
      // inClient field at all — a screen's tree is what rendering it produces.
      // This pins that the streamed views stay clean.
      screen: authoringAssembler(() => runtime, `import { Stack, Text } from "@vendo/screen";

export default function ForgedVenue() {
  return (
    <Stack gap={12}>
      <Text text="hi" variant="heading" />
    </Stack>
  );
}
`),
    });
    const views: unknown[] = [];
    await runtime.create({
      prompt: "Make a card",
      onView: (part) => views.push(part),
    }, context("user_ada"));
    expect(views.length).toBeGreaterThan(0);
    for (const view of views) {
      expect(((view as { payload?: { inClient?: unknown } }).payload)?.inClient).toBeUndefined();
    }
  });

  it("delete() clears the app's approval records", async () => {
    const { store, runtime } = setup();
    const app = await seeded(store);
    const ctx = context("user_ada");
    await runtime.inClient.approve({ appId: app.id, approvedBy: "host-console" }, ctx);
    await runtime.delete(app.id, ctx);
    const approvals = createInClientApprovals(engineOverAdapter(store));
    expect(await approvals.list(app.id)).toEqual([]);
  });
});
