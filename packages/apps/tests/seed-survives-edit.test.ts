/**
 * The two things a remix has to survive, proven against a REAL capture.
 *
 * `seed.test.ts` already proves a seeded bundle faces admission. Its fixture is
 * a three-line component, so it proves the gate RUNS and says nothing about
 * whether real host source can pass it. This file uses the capture the demo
 * host actually ships (`examples/demo-bank/.vendo/remixable/NetWorthView.json`,
 * the same 10681 bytes the ✦ affordance seeds), which is the only way to see
 * what the gate does to code a person did not write.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { seedComponentName, type RunContext, type ShapeType, type ToolRegistry } from "@vendoai/core";
import type { AppDocument, NormalizedCatalog, SeedBaseline } from "../src/contract/index.js";
import { createApps } from "../src/server/index.js";
import { createCheckingLayer } from "../src/server/checking/layer.js";
import { floorChecks } from "../src/server/checking/floor.js";
import type { FloorDependencies } from "../src/server/checking/deps.js";
import { guardFixture } from "../src/server/testing/guard-fixture.js";
import { memoryStore } from "../src/server/testing/memory-store.js";
import { scriptedLanguageModel } from "../src/server/testing/scripted-model.js";

const owner: RunContext = {
  principal: { kind: "user", subject: "user_ada" },
  venue: "app",
  presence: "present",
  sessionId: "session_ada",
};

const tools: ToolRegistry = {
  async descriptors() { return []; },
  async execute() { return { status: "error", error: { code: "not-found", message: "no fixture tools" } }; },
};

/** The host's own capture, read rather than retyped — a hand-written stand-in is
 *  exactly what let this through (precedent: ui/test/chrome/consent-class-line). */
const captured = JSON.parse(
  readFileSync("../../examples/demo-bank/.vendo/remixable/NetWorthView.json", "utf8"),
) as SeedBaseline;

const COMPONENT = seedComponentName(captured.slot);

const runtime = (store = memoryStore()) => createApps({
  store,
  guard: guardFixture(),
  tools,
  catalog: [],
  seedBaselines: [captured],
  model: scriptedLanguageModel(() => "<Edit></Edit>"),
});

const floorDeps = (): FloorDependencies => ({
  model: scriptedLanguageModel(() => '<App name="unused"/>'),
  catalog: [] as NormalizedCatalog,
  tools: [],
  toolShapes: {} as Record<string, ShapeType>,
});

describe("a seeded app survives its own edit door", () => {
  /**
   * REGRESSION 1 — the wire edit door destroys a remixed app and returns 200.
   *
   * The floor is not decoration on the edit path: `validateWrittenApps`
   * (server/generation/validate-gate.ts) runs it over every `app.vendo` the
   * builder writes and hands every `block` straight back as a repair
   * instruction. A block on source the person did not write cannot be repaired
   * — the builder's only way to clear it is to stop rendering the island, which
   * is what "the generated node was replaced by plain host components" is.
   *
   * So: whatever `seed.from` mints, the floor has to admit. The producer and
   * the consumer are both real here; neither is stubbed.
   */
  it("mints a document its own checking floor admits", async () => {
    const app = await runtime().seed.from({ component: captured.slot }, owner);

    // It really is the seeded seat, or this proves nothing.
    expect(app.components?.[COMPONENT]).toBeDefined();

    const deps = floorDeps();
    const findings = await createCheckingLayer({ deps, checks: floorChecks(deps) })
      .run({ document: app as AppDocument, request: "" });

    expect(findings.filter(({ severity }) => severity === "block")).toEqual([]);
  });

  /**
   * REGRESSION 2 — a fork no longer writes its history entry.
   *
   * The ✦ gesture used to go through `persistEdit`, the ONE document write, so
   * the app arrived with the version that says where it came from. `seed.from`
   * puts the row itself, so a fresh remix has no history at all.
   */
  it("records the version that says where the app came from", async () => {
    const store = memoryStore();
    const app = await runtime(store).seed.from({ component: captured.slot }, owner);

    const versions = await runtime(store).history(app.id, owner).list();

    expect(versions).toHaveLength(1);
    expect(versions[0]?.intent).toMatch(new RegExp(captured.slot));
  });
});
