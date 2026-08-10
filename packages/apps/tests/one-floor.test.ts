/**
 * ONE floor at every door.
 *
 * Three doors let an app reach a screen — the paint seam's floor
 * (`AppsRuntime.floor`, which composition hands the render seam),
 * `validate({ document })` and `validate({ appId })` — and each ran a different
 * subset of the checks. An island that crashes the moment it renders was caught
 * at exactly one of them: `validate({ document })` ran the smoke render, and the
 * paint seam and the stored-app door each shipped the same broken island without
 * ever executing it.
 *
 * There WAS a fourth door. Until "the brain dies" (9a3e81342) an edit ran a
 * validator of its own (`documentFromEdit`); since then an edit is the screen
 * assembler opening the app's own `app.vendo`, rewriting it and saving it, so
 * the save is checked by the paint seam's floor below and by nothing else. That
 * validator sat callerless and is deleted, and with it its carried-issue filter
 * — an edit excused for a stale node the previous version already carried —
 * which production has never had on this architecture: a block is a block, from
 * every author, on every commit (`../src/render-seam.ts`).
 *
 * These drive one deliberately-broken island through all three doors, each
 * through its own real entry point, and assert the SAME refusal at every one.
 * Nothing here stubs a check: the floor is the shipped floor, the store is a
 * real store, and the island really renders (and really crashes) in a worker.
 */
import {
  VENDO_APP_FORMAT,
  type RunContext,
  type ToolRegistry,
} from "@vendoai/core";
import {
  compileWire,
  type AppDocument,
  type NormalizedCatalog,
} from "../src/contract/index.js";
import { describe, expect, it } from "vitest";
import { createApps } from "../src/server/index.js";
import { guardFixture } from "../src/server/testing/guard-fixture.js";
import { memoryStore } from "../src/server/testing/memory-store.js";
import { scriptedLanguageModel } from "../src/server/testing/scripted-model.js";
import { seedAppRow } from "../src/server/testing/seed-app-row.js";
import type { FloorDependencies } from "../src/server/checking/deps.js";
import { blocks } from "../src/server/checking/floor.js";
import { wireCompileOptionsFor } from "../src/server/runtime/wire-options.js";

/** Renders once, reaches for a name nothing in the ambient scope carries, and
 *  takes the whole app down with it. It passes ADMISSION — valid TSX, no
 *  imports, no host tags, no network — so only the smoke render can see it. */
const CRASHING_ISLAND = `export default function BrokenCard() {
  return <div>{missingTotal.value}</div>;
}`;

const HEALTHY_ISLAND = `export default function BrokenCard() {
  return <div>steady</div>;
}`;

const wireWith = (island: string): string =>
  `<App name="Broken"><Island name="BrokenCard">${island}</Island><BrokenCard/></App>`;

const CRASH = /crashed in the smoke render/;

const catalog: NormalizedCatalog = [];
const floorDeps = (): FloorDependencies => ({ catalog, tools: [] });

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

/** A model that answers nothing useful: every door under test here is
 *  deterministic, and the reviewer is fail-open by design. */
const model = () => scriptedLanguageModel(() => "no");

const runtime = () =>
  createApps({ store: memoryStore(), guard: guardFixture(), tools, catalog, model: model() });

const documentWith = (island: string, id: string): AppDocument => {
  const compiled = compileWire(wireWith(island), wireCompileOptionsFor(floorDeps()));
  return {
    format: VENDO_APP_FORMAT,
    id,
    name: "Broken",
    ui: "tree",
    tree: compiled.tree as unknown as AppDocument["tree"],
    components: compiled.components,
  } as AppDocument;
};

describe("a crashing island is refused at every door", () => {
  it("the paint seam, which is where an edit's save lands too", async () => {
    // `AppsRuntime.floor(ctx)` verbatim — the object `packages/vendo` passes to
    // the render seam that wraps the screen assembler's workspace, so this is
    // the door for a files-first save, a `vendo_make` create AND an edit.
    const floor = runtime().floor(ctx);
    const compiled = await floor.compile(wireWith(CRASHING_ISLAND));

    const findings = blocks(await floor.check({ appId: "app_one_floor", compiled }));

    expect(findings.map(({ message }) => message).join("\n")).toMatch(CRASH);
  }, 60_000);

  it("validate({ document })", async () => {
    const apps = runtime();

    const result = await apps.validate({ document: wireWith(CRASHING_ISLAND) }, ctx);

    expect(result.ok).toBe(false);
    expect(result.findings.map(({ message }) => message).join("\n")).toMatch(CRASH);
  }, 60_000);

  it("validate({ appId })", async () => {
    const store = memoryStore();
    const apps = createApps({ store, guard: guardFixture(), tools, catalog, model: model() });
    await seedAppRow(store, documentWith(CRASHING_ISLAND, "app_stored_broken"), ctx.principal.subject);

    const result = await apps.validate({ appId: "app_stored_broken" }, ctx);

    expect(result.ok).toBe(false);
    expect(result.findings.map(({ message }) => message).join("\n")).toMatch(CRASH);
  }, 60_000);
});

describe("the floor still lets a sound app through every door", () => {
  it("the paint seam and validate({ document }) both say nothing", async () => {
    const apps = runtime();
    const floor = apps.floor(ctx);
    const compiled = await floor.compile(wireWith(HEALTHY_ISLAND));

    expect(blocks(await floor.check({ appId: "app_one_floor_ok", compiled }))).toEqual([]);
    expect((await apps.validate({ document: wireWith(HEALTHY_ISLAND) }, ctx)).ok).toBe(true);
  }, 60_000);
});
