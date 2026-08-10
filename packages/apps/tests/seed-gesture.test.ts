// The ✦ gesture (06-apps §8) — `seed.from` executes DETERMINISTICALLY when the
// user acts on a remixable component: the engine copies the captured baseline
// into a seeded seat with NO builder call. The generator never decides to seed;
// an instruction riding the gesture reaches the builder already scoped to an
// ordinary island edit on the app that now exists.
import type {
  RunContext,
  StoreAdapter,
  ToolRegistry,
} from "@vendoai/core";
import {
  bundleOf,
  seedComponentName,
  type AppDocument,
  type ScreenAssembler,
  type SeedBaseline,
} from "../src/contract/index.js";
import { describe, expect, it } from "vitest";
import { createApps, type AppsConfig, type AppsRuntime } from "../src/server/index.js";
import { scriptedAssembler } from "../src/server/testing/authoring-assembler.js";
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
const COMPONENT = seedComponentName(SLOT);
const SOURCE = `// Host provenance comment the seeded copy must carry.
export default function NetWorthCard() {
  return <strong>$1.2M</strong>;
}`;

const baseline: SeedBaseline = {
  slot: SLOT,
  source: SOURCE,
  hash: "sha256:maple-base",
  exportable: false,
  capturedAt: "2026-07-14T12:00:00.000Z",
  sampleProps: { valueCents: 120_000_000 },
};

const runtimeWith = (store: StoreAdapter, overrides: Partial<AppsConfig> = {}) => createApps({
  store,
  guard: guardFixture(),
  tools,
  catalog: [],
  seedBaselines: [baseline],
  ...overrides,
});

/** The one line the seeded card renders, rewritten. */
const relabelled = (source: string, label: string): string => source.replace(/\$1\.2M[^<]*/, label);

/** What an instruction asks that card to say — the whole change these tests are
 *  about, read out of the person's own words. */
const labelAsked = (instruction: string): string | undefined => {
  const colour = /\b(blue|green)\b/i.exec(instruction)?.[1];
  return colour === undefined ? undefined : `$1.2M in ${colour.toLowerCase()}`;
};

/**
 * The ONE builder, as a fixture: it opens the app's own document, rewrites the
 * seeded island in it and saves the whole thing back through `authored`. Only
 * the choice of new source stands in for a live screen agent — the write and
 * the recorded version are the runtime's own.
 */
const relabelScreen = (runtime: () => AppsRuntime, seen: string[] = []): ScreenAssembler =>
  scriptedAssembler(runtime, (request, current) => {
    seen.push(request.request);
    const entry = current?.components?.[COMPONENT];
    const source = entry === undefined ? undefined : bundleOf(entry).source;
    const label = labelAsked(request.request);
    if (source === undefined || label === undefined) {
      return { kind: "unavailable", why: `nothing in "${request.request}" names a change I can make to ${COMPONENT}` };
    }
    return `<App name="${current?.name ?? "My corner"}">
  <${COMPONENT} />
  <Island name="${COMPONENT}">${relabelled(source, label)}</Island>
</App>`;
  });

const sourceOf = (app: AppDocument | null | undefined): string | undefined => {
  const entry = app?.components?.[COMPONENT];
  return entry === undefined ? undefined : bundleOf(entry).source;
};

describe("06-apps §8 — the ✦ gesture is a deterministic create (seed.from)", () => {
  it("mints an ordinary app around the seed, with NO model call", async () => {
    const store = memoryStore();
    // No model configured at all: the gesture must not need one.
    const runtime = runtimeWith(store);

    const app = await runtime.seed.from({ component: SLOT }, ctx);

    expect(app.seed).toEqual({ component: SLOT, baseline: "sha256:maple-base" });
    // The TRUSTED captured source lands verbatim, comments included.
    expect(sourceOf(app)).toBe(SOURCE);
    expect(app.name).toBe(`${SLOT} remix`);
    // Persisted and owner-scoped like every other app.
    const listed = await runtime.list(ctx);
    expect(listed.map(({ id }) => id)).toContain(app.id);
    // Discovery semantics: the chrome finds the remix by the seed on the document.
    expect(listed.find(({ id }) => id === app.id)?.seed?.component).toBe(SLOT);
  });

  it("runs a gesture instruction as ONE ordinary edit, already scoped to the seat", async () => {
    const store = memoryStore();
    const asked: string[] = [];
    let runtime: AppsRuntime;
    runtime = runtimeWith(store, {
      model: basicLanguageModel(),
      screen: relabelScreen(() => runtime, asked),
    });

    const app = await runtime.seed.from({ component: SLOT, instruction: "make the number blue" }, ctx);

    expect(sourceOf(app)).toContain("$1.2M in blue");
    expect(app.seed).toMatchObject({ component: SLOT, baseline: "sha256:maple-base" });
    // Exactly one turn of the builder, and the app already existed when it ran.
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("make the number blue");
    // The gesture asks for an ordinary island edit, never for a fork op.
    expect(asked[0]).not.toContain("<ForkPin");
  });

  it("keeps the faithful copy when the scoped instruction edit fails", async () => {
    const store = memoryStore();
    const runtime = runtimeWith(store, {
      model: basicLanguageModel(),
      screen: { assemble: async () => ({ kind: "unavailable", why: "I could not write that change" }) },
    });

    const app = await runtime.seed.from({ component: SLOT, instruction: "make the number blue" }, ctx);

    // The seed half survives untouched — the person keeps the faithful copy.
    expect(app.seed).toEqual({ component: SLOT, baseline: "sha256:maple-base" });
    expect(sourceOf(app)).toBe(SOURCE);
    expect(sourceOf(await runtime.get(app.id, ctx))).toBe(SOURCE);
  });

  it("returns the persisted copy when the scoped edit THROWS", async () => {
    const store = memoryStore();
    // No model configured: the deterministic seed works, but the riding
    // instruction's edit throws ("generation requires a model"). The app is
    // already persisted, so the gesture must NOT surface as a thrown error.
    const runtime = runtimeWith(store);

    const app = await runtime.seed.from({ component: SLOT, instruction: "make the number blue" }, ctx);

    expect(app.seed).toEqual({ component: SLOT, baseline: "sha256:maple-base" });
    expect(sourceOf(app)).toBe(SOURCE);
    expect(await runtime.get(app.id, ctx)).toMatchObject({ id: app.id });
  });

  it("refuses a component the host never captured", async () => {
    const runtime = runtimeWith(memoryStore());
    await expect(runtime.seed.from({ component: "unknown-slot" }, ctx))
      .rejects.toThrow(/no captured baseline/);
  });

  it("scopes the new app to the person who made it", async () => {
    const store = memoryStore();
    const runtime = runtimeWith(store);
    const app = await runtime.seed.from({ component: SLOT }, ctx);

    const stranger: RunContext = { ...ctx, principal: { kind: "user", subject: "someone_else" } };
    expect((await runtime.list(stranger)).map(({ id }) => id)).not.toContain(app.id);
  });
});

describe("06-apps §8 — gesture idempotency (one remix per component, per person)", () => {
  it("returns the existing app on a second gesture instead of minting a duplicate", async () => {
    const store = memoryStore();
    const runtime = runtimeWith(store);

    const first = await runtime.seed.from({ component: SLOT }, ctx);
    const second = await runtime.seed.from({ component: SLOT }, ctx);

    expect(second.id).toBe(first.id);
    expect((await runtime.list(ctx)).filter(({ seed }) => seed?.component === SLOT)).toHaveLength(1);
  });

  it("drops a riding instruction on the dedupe hit — no edit, no model call", async () => {
    const store = memoryStore();
    const asked: string[] = [];
    let runtime: AppsRuntime;
    runtime = runtimeWith(store, {
      model: basicLanguageModel(),
      screen: relabelScreen(() => runtime, asked),
    });

    await runtime.seed.from({ component: SLOT }, ctx);
    const again = await runtime.seed.from({ component: SLOT, instruction: "make the number green" }, ctx);

    // The tap that created the app already carried its instruction; replaying it
    // here would apply the same edit twice.
    expect(asked).toHaveLength(0);
    expect(sourceOf(again)).toBe(SOURCE);
  });

  it("converges to ONE app when two gestures race past the pre-mint check", async () => {
    const store = memoryStore();
    const runtime = runtimeWith(store);

    const [left, right] = await Promise.all([
      runtime.seed.from({ component: SLOT }, ctx),
      runtime.seed.from({ component: SLOT }, ctx),
    ]);

    // Both racers pick the same winner — list order is deterministic, so only
    // the loser deletes itself.
    expect(left.id).toBe(right.id);
    expect((await runtime.list(ctx)).filter(({ seed }) => seed?.component === SLOT)).toHaveLength(1);
  });
});
