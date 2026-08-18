/**
 * The two things a remix has to survive, proven against a REAL capture.
 *
 * `seed.test.ts` works from a three-line fixture, so it can only prove the doors
 * RUN. This file uses the capture the demo host actually ships
 * (`examples/demo-bank/.vendo/remixable/NetWorthView.json`, 10681 bytes of code
 * a person did not write) — the only way to see what the ✦ gesture does with
 * real host source.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { RunContext, ToolRegistry } from "@vendoai/core";
import type { AppDocument, NormalizedCatalog, SeedBaseline } from "../src/contract/index.js";
import { createApps, type AppsRuntime } from "../src/server/index.js";
import { createCheckingLayer } from "../src/server/checking/layer.js";
import { screenTypesCheck } from "../src/server/checking/facts.js";
import type { FloorDependencies } from "../src/server/checking/deps.js";
import { guardFixture } from "../src/server/testing/guard-fixture.js";
import { memoryStore } from "../src/server/testing/memory-store.js";
import { basicLanguageModel, scriptedLanguageModel } from "../src/server/testing/scripted-model.js";
import { scriptedScreenAssembler } from "../src/server/testing/screen-assembler.js";

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

/** The gesture's own edit really runs here — the mint and the first edit are one
 *  operation, so a fixture that skipped the edit would test half of it. */
const runtime = (store = memoryStore()) => {
  let built: AppsRuntime;
  built = createApps({
    store,
    guard: guardFixture(),
    tools,
    catalog: [],
    seedBaselines: [captured],
    model: basicLanguageModel(),
    screen: scriptedScreenAssembler(
      () => built,
      () => "export default function Screen() {\n  return <strong>a sparkline</strong>;\n}\n",
    ),
  });
  return built;
};

const floorDeps = (): FloorDependencies => ({
  model: scriptedLanguageModel(() => '<App name="unused"/>'),
  catalog: [] as NormalizedCatalog,
  tools: [],
});

describe("a seeded app survives its own edit door", () => {
  /**
   * REGRESSION 1 — the mint used to carry the capture, and the wire edit door
   * then destroyed the app and returned 200.
   *
   * The floor is not decoration on the edit path: `validateWrittenApps`
   * (server/generation/validate-gate.ts) runs it over every `app.vendo` the
   * builder writes and hands every `block` straight back as a repair
   * instruction. A block on source the person did not write cannot be repaired —
   * the builder's only way to clear it was to stop rendering the island.
   *
   * The re-platform dissolves the premise rather than exempting it: the ✦ mint
   * carries NO captured source, so there is nothing for the gate to refuse and
   * nothing anywhere that could evaluate the host's bytes. Asserted against the
   * real capture, because a three-line fixture would pass either way.
   */
  it("mints a document that holds none of the captured source, and that its own floor admits", async () => {
    const app = await runtime().seed.from(
      { component: captured.slot, instruction: "show the balance as a sparkline" },
      owner,
    );

    // Provenance only: the hash of the capture, never its bytes.
    expect(app.seed).toEqual({
      component: captured.slot,
      baseline: captured.hash,
      wishes: ["show the balance as a sparkline"],
    });
    expect(app.components).toBeUndefined();
    expect(JSON.stringify(app)).not.toContain(captured.source.slice(0, 80));

    const deps = floorDeps();
    const findings = await createCheckingLayer({ checks: [screenTypesCheck(deps)] })
      .run({ document: app as AppDocument, request: "" });

    expect(findings.filter(({ severity }) => severity === "block")).toEqual([]);
  });

  /**
   * REGRESSION 2 — a fork no longer writes its history entry.
   *
   * The ✦ gesture used to go through `persistEdit`, the ONE document write, so
   * the app arrived with the version that says where it came from. `seed.from`
   * puts the row itself, so a fresh remix has no history at all.
   *
   * One gesture, two entries: where the remix came from, and the first edit —
   * the trail says both because the gesture did both.
   */
  it("records the version that says where the app came from", async () => {
    const store = memoryStore();
    const app = await runtime(store).seed.from(
      { component: captured.slot, instruction: "show the balance as a sparkline" },
      owner,
    );

    const intents = (await runtime(store).history(app.id, owner).list()).map(({ intent }) => intent);

    expect(intents).toHaveLength(2);
    expect(intents.some((intent) => intent.includes(captured.slot))).toBe(true);
    expect(intents).toContain("show the balance as a sparkline");
  });
});
