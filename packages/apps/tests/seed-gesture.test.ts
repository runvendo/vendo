// The ✦ gesture (06-apps §8) — `seed.from` is ONE operation: it records where
// the remix came from and runs the person's instruction through the ORDINARY
// edit door, so what comes back is a regular screen app (`app.tsx`) that happens
// to carry provenance. Nothing copies the captured host source into the document
// and nothing evaluates one.
import type {
  RunContext,
  StoreAdapter,
  ToolRegistry,
} from "@vendoai/core";
import {
  SCREEN_FILE,
  type AppDocument,
  type SeedBaseline,
} from "../src/contract/index.js";
import { describe, expect, it } from "vitest";
import { createApps, type AppsConfig, type AppsRuntime } from "../src/server/index.js";
import { scriptedScreenAssembler } from "../src/server/testing/screen-assembler.js";
import { FIXTURE_SCREEN } from "../src/server/testing/screen-document.js";
import { guardFixture } from "../src/server/testing/guard-fixture.js";
import { memoryStore } from "../src/server/testing/memory-store.js";
import { basicLanguageModel } from "../src/server/testing/scripted-model.js";

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_gesture" },
  venue: "app",
  presence: "present",
  sessionId: "session_gesture",
};

const tools: ToolRegistry = {
  async descriptors() { return []; },
  async execute() { return { status: "error", error: { code: "not-found", message: "missing" } }; },
};

const SLOT = "net-worth-card";

const baseline: SeedBaseline = {
  slot: SLOT,
  source: "export default function NetWorthCard() {\n  return <strong>$1.2M</strong>;\n}",
  hash: "sha256:maple-base",
  exportable: false,
  capturedAt: "2026-07-14T12:00:00.000Z",
  sampleProps: { valueCents: 120_000_000 },
  // The splitter's half: what the ✦ seeds as the new app's own `app.tsx`, so the
  // first edit changes the component's real ported code. A baseline without one
  // gets no remix at all, which is what the refusal case below asserts.
  ported: { source: FIXTURE_SCREEN, tools: [], holes: [] },
};

const runtimeWith = (store: StoreAdapter, overrides: Partial<AppsConfig> = {}) => createApps({
  store,
  guard: guardFixture(),
  tools,
  catalog: [],
  seedBaselines: [baseline],
  ...overrides,
});

/** What an instruction asks the screen to say — the whole change these tests are
 *  about, read out of the person's own words. */
const colourAsked = (instruction: string): string | undefined =>
  /\b(blue|green)\b/i.exec(instruction)?.[1]?.toLowerCase();

/**
 * The ONE builder, as a fixture: it writes the app's own `app.tsx` and saves it
 * through `authoredScreen`. Only the choice of source stands in for a live
 * screen agent — the write, the row and the recorded version are the runtime's.
 */
const colourScreen = (runtime: () => AppsRuntime, seen: string[] = []) =>
  scriptedScreenAssembler(runtime, (request) => {
    seen.push(request.request);
    const colour = colourAsked(request.request);
    if (colour === undefined) {
      return { kind: "unavailable" as const, why: `nothing in "${request.request}" names a change I can make` };
    }
    return `export default function Screen() {\n  return <strong style={{ color: "${colour}" }}>$1.2M</strong>;\n}\n`;
  });

const screenOf = (app: AppDocument | null | undefined): string | undefined =>
  app?.source?.[SCREEN_FILE]?.text;

describe("06-apps §8 — the ✦ gesture is a fork and a first edit in one (seed.from)", () => {
  it("answers with an ordinary SCREEN app carrying the instruction as provenance", async () => {
    const store = memoryStore();
    const asked: string[] = [];
    let runtime: AppsRuntime;
    runtime = runtimeWith(store, {
      model: basicLanguageModel(),
      screen: colourScreen(() => runtime, asked),
    });

    const app = await runtime.seed.from({ component: SLOT, instruction: "make the number blue" }, ctx);

    // The person's own words, recorded verbatim beside where the remix came from.
    expect(app.seed).toEqual({
      component: SLOT,
      baseline: "sha256:maple-base",
      wishes: ["make the number blue"],
    });
    // The remix IS its screen — no captured seat, nothing copied.
    expect(screenOf(app)).toContain('color: "blue"');
    expect(app.components).toBeUndefined();
    expect(app.name).toBe(`${SLOT} remix`);
    // Exactly one turn of the builder, and the app already existed when it ran.
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("make the number blue");
    // Persisted, owner-scoped, and discoverable by the chrome through the seed.
    const listed = await runtime.list(ctx);
    expect(listed.find(({ id }) => id === app.id)?.seed?.component).toBe(SLOT);
  });

  it("leaves the host's original standing when the first edit cannot be written", async () => {
    const store = memoryStore();
    const runtime = runtimeWith(store, {
      model: basicLanguageModel(),
      screen: { assemble: async () => ({ kind: "unavailable", why: "I could not write that change" }) },
    });

    const app = await runtime.seed.from({ component: SLOT, instruction: "make the number blue" }, ctx);

    // The provenance is stored and the app does not open, so the wrapper keeps
    // the host component it was going to replace. That is the claim, and it is
    // the terminal marker that carries it now — not an absent screen.
    expect(app.seed?.wishes).toEqual(["make the number blue"]);
    expect(await runtime.open(app.id, ctx)).toMatchObject({ kind: "failed" });
    // OPEN QUESTION, deliberately not asserted either way: the app DOES now hold
    // a screen — the splitter's port, seeded and gauntlet-passed before the
    // instruction ran — and the marker is what keeps it shut. Whether a person
    // whose first instruction failed should be handed that working port instead
    // of nothing is a user-visible call that has not been made. Today's answer is
    // "nothing", and this test pins only today's answer.
    expect(app.buildFailed?.reason).toBeDefined();
  });

  it("marks a first edit that could not be written as FAILED, and lets the next tap retry", async () => {
    const store = memoryStore();
    const runtime = runtimeWith(store, {
      model: basicLanguageModel(),
      screen: { assemble: async () => ({ kind: "unavailable", why: "I could not write that change" }) },
    });

    const app = await runtime.seed.from({ component: SLOT, instruction: "make the number blue" }, ctx);

    // The edit door RETURNS its common failure instead of throwing, so a
    // gesture that only caught throws left a screenless app that polled as
    // pending forever. The terminal marker is the same one a failed build
    // leaves, and it is what the ✦ pill renders as "didn't load".
    expect(await runtime.open(app.id, ctx)).toMatchObject({ kind: "failed", retryable: true });
    // …and a failed build is not a remix the chrome can find, so the next tap
    // mints a fresh app rather than deduping onto this dead one forever.
    expect((await runtime.list(ctx)).map(({ id }) => id)).not.toContain(app.id);
    const retried = await runtime.seed.from({ component: SLOT, instruction: "make the number blue" }, ctx);
    expect(retried.id).not.toBe(app.id);
  });

  it("does not surface as a thrown gesture when the edit itself THROWS", async () => {
    const store = memoryStore();
    // No model configured: the mint works, the riding edit throws ("generation
    // requires a model"). The app is already persisted, so the gesture must not
    // hand the caller an error over a row that exists.
    const runtime = runtimeWith(store);

    const app = await runtime.seed.from({ component: SLOT, instruction: "make the number blue" }, ctx);

    expect(app.seed?.wishes).toEqual(["make the number blue"]);
    expect(await runtime.get(app.id, ctx)).toMatchObject({ id: app.id });
  });

  it("refuses a component the host never captured", async () => {
    const runtime = runtimeWith(memoryStore());
    await expect(runtime.seed.from({ component: "unknown-slot", instruction: "make it blue" }, ctx))
      .rejects.toThrow(/no captured baseline/);
  });

  it("scopes the new app to the person who made it", async () => {
    const store = memoryStore();
    const runtime = runtimeWith(store);
    const app = await runtime.seed.from({ component: SLOT, instruction: "make it blue" }, ctx);

    const stranger: RunContext = { ...ctx, principal: { kind: "user", subject: "someone_else" } };
    expect((await runtime.list(stranger)).map(({ id }) => id)).not.toContain(app.id);
  });
});

describe("06-apps §8 — gesture idempotency (one remix per component, per person)", () => {
  it("returns the existing app on a second gesture instead of minting a duplicate", async () => {
    const store = memoryStore();
    let runtime: AppsRuntime;
    runtime = runtimeWith(store, { model: basicLanguageModel(), screen: colourScreen(() => runtime) });

    const first = await runtime.seed.from({ component: SLOT, instruction: "make it blue" }, ctx);
    const second = await runtime.seed.from({ component: SLOT, instruction: "make it green" }, ctx);

    expect(second.id).toBe(first.id);
    expect((await runtime.list(ctx)).filter(({ seed }) => seed?.component === SLOT)).toHaveLength(1);
  });

  it("drops the riding instruction on the dedupe hit — no edit, no model call", async () => {
    const store = memoryStore();
    const asked: string[] = [];
    let runtime: AppsRuntime;
    runtime = runtimeWith(store, {
      model: basicLanguageModel(),
      screen: colourScreen(() => runtime, asked),
    });

    await runtime.seed.from({ component: SLOT, instruction: "make the number blue" }, ctx);
    asked.length = 0;
    const again = await runtime.seed.from({ component: SLOT, instruction: "make the number green" }, ctx);

    // The tap that created the app already carried its instruction, and this app
    // is that tap's answer — replaying a second one here would edit it twice.
    expect(asked).toHaveLength(0);
    expect(again.seed?.wishes).toEqual(["make the number blue"]);
    expect(screenOf(again)).toContain('color: "blue"');
  });

  it("converges to ONE app when two gestures race past the pre-mint check", async () => {
    const store = memoryStore();
    let runtime: AppsRuntime;
    runtime = runtimeWith(store, { model: basicLanguageModel(), screen: colourScreen(() => runtime) });

    const [left, right] = await Promise.all([
      runtime.seed.from({ component: SLOT, instruction: "make it blue" }, ctx),
      runtime.seed.from({ component: SLOT, instruction: "make it green" }, ctx),
    ]);

    // Both racers pick the same winner — list order is deterministic, so only
    // the loser deletes itself.
    expect(left.id).toBe(right.id);
    expect((await runtime.list(ctx)).filter(({ seed }) => seed?.component === SLOT)).toHaveLength(1);
  });
});
