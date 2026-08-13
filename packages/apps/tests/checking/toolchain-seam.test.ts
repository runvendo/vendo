/**
 * `AppsConfig.toolchain`, end to end — the WIRING, not the interface.
 *
 * The slot is only a feature if the toolchain a host passes to `createApps` is
 * the one that really compiles, type-checks and paints its screens. Everything
 * between the two is composition — the config, the build surface, the floor the
 * render seam is handed, the stored-app `validate` door — and none of it has a
 * verdict of its own, so a broken thread there is invisible to every other test:
 * the gauntlet passes on its own toolchain, the toolchain passes on its own
 * fixtures, and each proves the other is fine. That is the shape of failure this
 * repo has already shipped four times (host-component previews), so the two
 * doors that reach the gauntlet are driven here through the REAL runtime, with
 * nothing stubbed in between.
 *
 * The recorder DELEGATES to the Node toolchain rather than faking one: a
 * recorder that answered for itself would prove the calls were made and not that
 * their answers are what the door acts on.
 */
import { VENDO_APP_FORMAT, engineOverAdapter, sha256Hex, type RunContext, type ToolRegistry } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { SCREEN_FILE, type AppDocument, type NormalizedCatalog } from "../../src/contract/index.js";
import { createApps } from "../../src/server/index.js";
import { nodeToolchain, type ScreenToolchain } from "../../src/server/checking/toolchain.js";
import { guardFixture } from "../../src/server/testing/guard-fixture.js";
import { memoryStore } from "../../src/server/testing/memory-store.js";
import { scriptedLanguageModel } from "../../src/server/testing/scripted-model.js";
import { seedAppRow } from "../../src/server/testing/seed-app-row.js";

/** One Kit component, no queries: this screen is about the wiring, and a tool
 *  call would only add a second thing that could fail. */
const SCREEN = `import { Text } from "@vendo/screen";

export default function Hello() {
  return <Text text="hi" />;
}
`;

const catalog: NormalizedCatalog = [];

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

/** The reviewer is fail-open, and no door under test here reads a model
 *  answer — the same posture one-floor.test.ts takes. */
const model = () => scriptedLanguageModel(() => "no");

interface Recorder {
  toolchain: ScreenToolchain;
  calls: string[];
}

const recording = (): Recorder => {
  const real = nodeToolchain();
  const calls: string[] = [];
  return {
    calls,
    toolchain: {
      transform: (source) => { calls.push("transform"); return real.transform(source); },
      typecheck: (input) => { calls.push("typecheck"); return real.typecheck(input); },
      paint: (input) => { calls.push("paint"); return real.paint(input); },
    },
  };
};

/** The stored form of a component screen: the `.tsx` IS the app, so the row
 *  carries source and no tree — what `commitApp` lands. */
const storedScreen = (id: string): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id,
  name: "Hello",
  ui: "tree",
  source: {
    [SCREEN_FILE]: {
      hash: `sha256:${sha256Hex(SCREEN)}`,
      bytes: new TextEncoder().encode(SCREEN).byteLength,
      text: SCREEN,
    },
  },
} as AppDocument);

describe("the toolchain a host passes to createApps is the one its screens face", () => {
  it("at the paint seam's floor — AppsRuntime.floor(ctx).component", async () => {
    const recorder = recording();
    const apps = createApps({
      store: memoryStore(),
      guard: guardFixture(),
      tools,
      catalog,
      model: model(),
      toolchain: recorder.toolchain,
    });

    const painted = await apps.floor(ctx).component?.({ appId: "app_seam_floor", source: SCREEN });

    // All three stages, in the gauntlet's own order, and the paint the door
    // hands back is the one this toolchain produced.
    expect(recorder.calls).toEqual(["transform", "typecheck", "paint"]);
    expect(painted?.ok).toBe(true);
  }, 60_000);

  it("at the stored-app door — AppsRuntime.validate({ appId })", async () => {
    const recorder = recording();
    const store = memoryStore();
    const apps = createApps({
      store,
      guard: guardFixture(),
      tools,
      catalog,
      model: model(),
      toolchain: recorder.toolchain,
    });
    await seedAppRow(engineOverAdapter(store), storedScreen("app_seam_validate"), ctx.principal.subject);

    const verdict = await apps.validate({ appId: "app_seam_validate" }, ctx);

    expect(recorder.calls).toEqual(["transform", "typecheck", "paint"]);
    expect(verdict.ok).toBe(true);
  }, 60_000);
});
