/**
 * ONE floor at every door.
 *
 * Four doors let an app reach a screen — the paint seam (`createAppFloor`),
 * `validate({ document })`, `validate({ appId })`, and the edit path — and each
 * ran a different subset of the checks. An island that crashes the moment it
 * renders was caught at exactly one of them: `validate({ document })` ran the
 * smoke render, and the paint seam, the stored-app door and the edit path each
 * shipped the same broken island without ever executing it.
 *
 * These drive one deliberately-broken island through all four doors, each
 * through its own real entry point, and assert the SAME refusal at every one.
 * Nothing here stubs a check: the floor is the shipped floor, the store is a
 * real store, and the island really renders (and really crashes) in a worker.
 */
import {
  compileWire,
  VENDO_APP_FORMAT,
  type AppDocument,
  type NormalizedCatalog,
  type RunContext,
  type ToolRegistry,
} from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { documentFromEdit } from "./generation/validation/validate.js";
import type { GenerationDependencies } from "./generation/engine.js";
import { createApps } from "./index.js";
import { guardFixture, memoryStore, scriptedLanguageModel, seedAppRow } from "./testing/index.js";
import type { FloorDependencies } from "./checking/deps.js";
import { blocks, createAppFloor } from "./checking/floor.js";
import { wireCompileOptionsFor } from "./wire-options.js";

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
  it("the paint seam", async () => {
    const floor = createAppFloor({ deps: async () => floorDeps() });
    const compiled = await floor.compile(wireWith(CRASHING_ISLAND));

    const findings = blocks(await floor.check({ appId: "app_one_floor", compiled }));

    expect(findings.map(({ message }) => message).join("\n")).toMatch(CRASH);
  }, 60_000);

  it("validate({ document })", async () => {
    const runtime = createApps({ store: memoryStore(), guard: guardFixture(), tools, catalog, model: model() });

    const result = await runtime.validate({ document: wireWith(CRASHING_ISLAND) }, ctx);

    expect(result.ok).toBe(false);
    expect(result.findings.map(({ message }) => message).join("\n")).toMatch(CRASH);
  }, 60_000);

  it("validate({ appId })", async () => {
    const store = memoryStore();
    const runtime = createApps({ store, guard: guardFixture(), tools, catalog, model: model() });
    await seedAppRow(store, documentWith(CRASHING_ISLAND, "app_stored_broken"), ctx.principal.subject);

    const result = await runtime.validate({ appId: "app_stored_broken" }, ctx);

    expect(result.ok).toBe(false);
    expect(result.findings.map(({ message }) => message).join("\n")).toMatch(CRASH);
  }, 60_000);

  it("the edit path", async () => {
    const deps = { ...floorDeps(), model: model() } as unknown as GenerationDependencies;
    const previous = documentWith(HEALTHY_ISLAND, "app_edited");

    const built = await documentFromEdit(
      previous,
      compileWire(wireWith(CRASHING_ISLAND), wireCompileOptionsFor(deps)),
      deps,
      "make the card show the total",
    );

    expect(built.document).toBeUndefined();
    expect(built.issues.join("\n")).toMatch(CRASH);
  }, 60_000);
});

describe("the floor still lets a sound app through every door", () => {
  it("the paint seam and validate({ document }) both say nothing", async () => {
    const floor = createAppFloor({ deps: async () => floorDeps() });
    const compiled = await floor.compile(wireWith(HEALTHY_ISLAND));
    const runtime = createApps({ store: memoryStore(), guard: guardFixture(), tools, catalog, model: model() });

    expect(blocks(await floor.check({ appId: "app_one_floor_ok", compiled }))).toEqual([]);
    expect((await runtime.validate({ document: wireWith(HEALTHY_ISLAND) }, ctx)).ok).toBe(true);
  }, 60_000);

  it("an edit does not inherit the blame for an island that was already broken", async () => {
    // The carried-issue rule: the previous app's island crashes, the edit does
    // not touch it, so the edit lands rather than being blocked by history.
    const deps = { ...floorDeps(), model: model() } as unknown as GenerationDependencies;
    const previous = documentWith(CRASHING_ISLAND, "app_already_broken");
    const edited = wireWith(CRASHING_ISLAND).replace("<BrokenCard/>", '<BrokenCard/><Text text="added"/>');

    const built = await documentFromEdit(
      previous,
      compileWire(edited, wireCompileOptionsFor(deps)),
      deps,
      "add a caption",
    );

    expect(built.issues).toEqual([]);
    expect(built.document).toBeDefined();
  }, 60_000);
});
