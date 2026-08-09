// Gesture-owned forking (2026-07-21) — the fork executes DETERMINISTICALLY
// when the user acts on a remixable slot (pins.fork): the engine copies the
// captured source and records the pin with NO builder call. The generator lost
// the fork decision entirely; an instruction riding the gesture reaches the
// builder already scoped to an ordinary island edit on the existing fork.
import type { AppDocument, RunContext, ScreenAssembler, StoreAdapter, ToolRegistry, Tree } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createApps, type AppsConfig, type AppsRuntime, type PinBaseline } from "../src/index.js";
import { detectPinDrift, pinComponentName } from "../src/pins.js";
import { scriptedAssembler } from "../src/testing/authoring-assembler.js";
import { guardFixture } from "../src/testing/guard-fixture.js";
import { memoryStore } from "../src/testing/memory-store.js";
import { basicLanguageModel } from "../src/testing/scripted-model.js";
import { seedAppRow } from "../src/testing/seed-app-row.js";

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
const COMPONENT = pinComponentName(SLOT);
const SOURCE = `// Host provenance comment the fork must carry.
export default function NetWorthCard() {
  return <strong>$1.2M</strong>;
}`;

const baseline: PinBaseline = {
  slot: SLOT,
  source: SOURCE,
  hash: "sha256:maple-base",
  exportable: false,
  capturedAt: "2026-07-14T12:00:00.000Z",
  sampleProps: { valueCents: 120_000_000 },
};

const seedDoc = (id = "app_gesture"): AppDocument => ({
  format: "vendo/app@1",
  id,
  name: "My corner",
  ui: "tree",
  tree: {
    formatVersion: "vendo-genui/v2",
    root: "root",
    nodes: [{ id: "root", component: "Stack", source: "prewired" }],
  },
});

const runtimeWith = (store: StoreAdapter, overrides: Partial<AppsConfig> = {}) => createApps({
  store,
  guard: guardFixture(),
  tools,
  catalog: [],
  pinBaselines: [baseline],
  ...overrides,
});

/** The one line the pinned card renders, rewritten. */
const relabelled = (source: string, label: string): string => source.replace(/\$1\.2M[^<]*/, label);

/** What an instruction asks that card to say — the whole change these tests are
 *  about, read out of the person's own words. */
const labelAsked = (instruction: string): string | undefined => {
  const colour = /\b(blue|green)\b/i.exec(instruction)?.[1];
  return colour === undefined ? undefined : `$1.2M in ${colour.toLowerCase()}`;
};

/**
 * The ONE builder, as a fixture: it opens the app's own document, rewrites the
 * pinned island in it and saves the whole thing back through `authored`. Only
 * the choice of new source stands in for a live screen agent — the write, the
 * recorded version and the recorded pin intent are the runtime's own.
 */
const relabelScreen = (runtime: () => AppsRuntime, seen: string[] = []): ScreenAssembler =>
  scriptedAssembler(runtime, (request, current) => {
    seen.push(request.request);
    const source = current?.components?.[COMPONENT];
    const label = labelAsked(request.request);
    if (source === undefined || label === undefined) {
      return { kind: "unavailable", why: `nothing in "${request.request}" names a change I can make to ${COMPONENT}` };
    }
    return `<App name="${current?.name ?? "My corner"}">
  <${COMPONENT} />
  <Island name="${COMPONENT}">${relabelled(source, label)}</Island>
</App>`;
  });

describe("06-apps §8 — gesture-owned deterministic fork (pins.fork)", () => {
  it("forks into an existing app with NO model call and records the pin trail", async () => {
    const store = memoryStore();
    const app = seedDoc();
    await seedAppRow(store, app, ctx.principal.subject);
    // No model configured at all: the gesture fork must not need one.
    const runtime = runtimeWith(store);

    const forked = await runtime.pins.fork({ appId: app.id, slot: SLOT }, ctx);
    expect(forked.slot).toBe(SLOT);
    expect(forked.componentName).toBe(COMPONENT);
    expect(forked.edit).toBeUndefined();
    expect(forked.app.pins).toEqual([{ slot: SLOT, base: "sha256:maple-base" }]);
    // The TRUSTED captured source lands verbatim (comments included).
    expect(forked.app.components?.[COMPONENT]).toBe(SOURCE);
    expect(forked.app.tree?.nodes).toContainEqual(expect.objectContaining({
      component: COMPONENT,
      source: "generated",
    }));
    expect(forked.version.intent).toBe(`Remix the host component "${SLOT}"`);
    // The fork is a recorded version, under its own intent.
    const versions = await runtime.history(app.id, ctx).list();
    expect(versions.map(({ intent }) => intent)).toContain(forked.version.intent);
  });

  it("mints a minimal app around the fork when the gesture hits an empty slot", async () => {
    const store = memoryStore();
    const runtime = runtimeWith(store);

    const forked = await runtime.pins.fork({ slot: SLOT }, ctx);
    expect(forked.app.pins).toEqual([{ slot: SLOT, base: "sha256:maple-base" }]);
    expect(forked.app.components?.[COMPONENT]).toBe(SOURCE);
    expect(forked.app.name).toBe(`${SLOT} remix`);
    // Persisted and owner-scoped like every app.
    const listed = await runtime.list(ctx);
    expect(listed.map(({ id }) => id)).toContain(forked.app.id);
    // Slot discovery semantics: the new app carries the pin the slot resolves by.
    expect(listed.find(({ id }) => id === forked.app.id)?.pins).toEqual([{ slot: SLOT, base: "sha256:maple-base" }]);
  });

  it("stores the gesture's serializable live props as the pinned node's seed (2026-08-02 final shape)", async () => {
    const store = memoryStore();
    const runtime = runtimeWith(store);

    // The wrapper snapshots its serializable live props at fork time; they
    // land as the pinned node's props — the fork's dashboard seed when it is
    // placed away from the host page. In place, the wrapper streams live
    // props instead, merged OVER this seed.
    const props = { valueCents: 549_071_500, series: [1, 2, 3] };
    const forked = await runtime.pins.fork({ slot: SLOT, props }, ctx);
    expect(forked.app.tree?.nodes).toContainEqual(expect.objectContaining({
      component: COMPONENT,
      source: "generated",
      props,
    }));
    // Persisted, not just returned.
    const stored = (await runtime.list(ctx)).find(({ id }) => id === forked.app.id);
    const storedNodes = (stored?.tree as unknown as Tree | undefined)?.nodes;
    expect(storedNodes?.find((node) => node.component === COMPONENT)?.props).toEqual(props);
  });

  it("runs a gesture instruction as ONE ordinary edit, already scoped to the fork", async () => {
    const store = memoryStore();
    const app = seedDoc();
    await seedAppRow(store, app, ctx.principal.subject);
    const asked: string[] = [];
    let runtime: AppsRuntime;
    runtime = runtimeWith(store, {
      model: basicLanguageModel(),
      screen: relabelScreen(() => runtime, asked),
    });

    const forked = await runtime.pins.fork(
      { appId: app.id, slot: SLOT, instruction: "make the number blue" },
      ctx,
    );
    expect(forked.edit?.failure).toBeUndefined();
    expect(forked.app.components?.[COMPONENT]).toContain("$1.2M in blue");
    expect(forked.app.pins).toEqual([{ slot: SLOT, base: "sha256:maple-base" }]);
    // Exactly one turn of the builder, and it was scoped: the fork already exists.
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain(`already forked into the generated component "${COMPONENT}"`);
    expect(asked[0]).toContain("make the number blue");
    // The gesture asks for an ordinary island edit, never for a fork.
    expect(asked[0]).not.toContain("<ForkPin");
  });

  it("keeps the faithful fork when the scoped instruction edit fails", async () => {
    const store = memoryStore();
    const app = seedDoc();
    await seedAppRow(store, app, ctx.principal.subject);
    const runtime = runtimeWith(store, {
      model: basicLanguageModel(),
      screen: { assemble: async () => ({ kind: "unavailable", why: "I could not write that change" }) },
    });

    const forked = await runtime.pins.fork(
      { appId: app.id, slot: SLOT, instruction: "make the number blue" },
      ctx,
    );
    // Loud failure on the edit half; the fork half survives untouched.
    expect(forked.edit?.failure).toBeDefined();
    expect(forked.app.pins).toEqual([{ slot: SLOT, base: "sha256:maple-base" }]);
    expect(forked.app.components?.[COMPONENT]).toBe(SOURCE);
    const stored = await runtime.get(app.id, ctx);
    expect(stored?.pins).toEqual([{ slot: SLOT, base: "sha256:maple-base" }]);
    expect(stored?.components?.[COMPONENT]).toBe(SOURCE);
  });

  it("returns the persisted fork with a loud edit failure when the scoped edit THROWS", async () => {
    const store = memoryStore();
    const app = seedDoc();
    await seedAppRow(store, app, ctx.principal.subject);
    // No model configured: the deterministic fork works, but the riding
    // instruction's edit throws ("generation requires a model"). The fork
    // already persisted, so the gesture must NOT surface as a thrown error —
    // the caller gets the faithful fork plus a failure-shaped edit.
    const runtime = runtimeWith(store);

    const forked = await runtime.pins.fork(
      { appId: app.id, slot: SLOT, instruction: "make the number blue" },
      ctx,
    );
    expect(forked.edit?.failure).toBeDefined();
    expect(forked.edit?.issues?.join(" ")).toContain("generation requires a model");
    expect(forked.app.pins).toEqual([{ slot: SLOT, base: "sha256:maple-base" }]);
    expect(forked.app.components?.[COMPONENT]).toBe(SOURCE);
    const stored = await runtime.get(app.id, ctx);
    expect(stored?.pins).toEqual([{ slot: SLOT, base: "sha256:maple-base" }]);
  });

  it("refuses an uncaptured slot and a duplicate fork loudly", async () => {
    const store = memoryStore();
    const app = seedDoc();
    await seedAppRow(store, app, ctx.principal.subject);
    const runtime = runtimeWith(store);

    await expect(runtime.pins.fork({ appId: app.id, slot: "unknown-slot" }, ctx))
      .rejects.toThrow(/no captured baseline/);
    await runtime.pins.fork({ appId: app.id, slot: SLOT }, ctx);
    await expect(runtime.pins.fork({ appId: app.id, slot: SLOT }, ctx))
      .rejects.toThrow(/already forked/);
  });

  it("scopes the fork to the owner", async () => {
    const store = memoryStore();
    const app = seedDoc();
    await seedAppRow(store, app, "someone_else");
    const runtime = runtimeWith(store);

    await expect(runtime.pins.fork({ appId: app.id, slot: SLOT }, ctx))
      .rejects.toThrow(/not found/);
  });

  it("rebases a gesture fork after host drift by replaying only the later edit intents", async () => {
    const store = memoryStore();
    const app = seedDoc();
    await seedAppRow(store, app, ctx.principal.subject);
    let forkRuntime: AppsRuntime;
    forkRuntime = runtimeWith(store, {
      model: basicLanguageModel(),
      screen: relabelScreen(() => forkRuntime),
    });
    const forked = await forkRuntime.pins.fork(
      { appId: app.id, slot: SLOT, instruction: "make the number blue" },
      ctx,
    );
    expect(forked.edit?.failure).toBeUndefined();

    // The host updates the component and resyncs: same store, new baseline.
    const NEW_SOURCE = SOURCE.replace("NetWorthCard()", "NetWorthCard() /* v2 */");
    const newBaseline: PinBaseline = { ...baseline, source: NEW_SOURCE, hash: "sha256:maple-new" };
    let rebaseRuntime: AppsRuntime;
    rebaseRuntime = runtimeWith(store, {
      pinBaselines: [newBaseline],
      model: basicLanguageModel(),
      screen: relabelScreen(() => rebaseRuntime),
    });
    expect(detectPinDrift((await rebaseRuntime.get(app.id, ctx))!, [newBaseline])).toEqual([
      expect.objectContaining({ slot: SLOT, reason: "baseline-changed" }),
    ]);
    const rebase = await rebaseRuntime.pins.rebase({ appId: app.id, slot: SLOT }, ctx);
    expect(rebase.status).toBe("rebased");
    if (rebase.status !== "rebased") throw new Error("expected rebased");
    // Only the LATER modification replays — the gesture fork itself is
    // mechanical (intents[0] by construction), never re-sent to the builder.
    expect(rebase.replayed.length).toBe(1);
    expect(rebase.replayed[0]).toContain("make the number blue");
    expect(rebase.app.pins).toEqual([{ slot: SLOT, base: "sha256:maple-new" }]);
    expect(rebase.app.components?.[COMPONENT]).toContain("$1.2M in blue");
    expect(rebase.app.components?.[COMPONENT]).toContain("/* v2 */");
  });
});

// Remix final shape (2026-08-02) — the appId-less gesture is idempotent per
// (subject, slot): the server dedupes, so a double-tap can never mint a
// duplicate app and the UI latch is cosmetic.
describe("06-apps §8 — fork idempotency (appId-less dedupe)", () => {
  it("returns the existing app on a second gesture instead of minting a duplicate", async () => {
    const store = memoryStore();
    const runtime = runtimeWith(store);

    const first = await runtime.pins.fork({ slot: SLOT }, ctx);
    const second = await runtime.pins.fork({ slot: SLOT }, ctx);
    expect(second.app.id).toBe(first.app.id);
    expect(second.app).toEqual(first.app);
    expect(second.slot).toBe(SLOT);
    expect(second.componentName).toBe(COMPONENT);
    // The result still describes the recorded deterministic fork.
    expect(second.version.intent).toBe(`Remix the host component "${SLOT}"`);

    // One app row, not two.
    const listed = await runtime.list(ctx);
    expect(listed.filter(({ pins }) => pins?.some((pin) => pin.slot === SLOT))).toHaveLength(1);
  });

  it("drops a riding instruction on the dedupe hit — no edit, no model call", async () => {
    const store = memoryStore();
    // No model configured: an edit attempt on the dedupe path would surface
    // as a failure-shaped edit, so an undefined `edit` proves none ran.
    const runtime = runtimeWith(store);

    const first = await runtime.pins.fork({ slot: SLOT }, ctx);
    const second = await runtime.pins.fork({ slot: SLOT, instruction: "Make it green" }, ctx);
    expect(second.app.id).toBe(first.app.id);
    expect(second.edit).toBeUndefined();
    expect(second.app).toEqual(first.app);
  });

  it("converges to ONE app when two appId-less gestures race past the pre-mint check", async () => {
    const store = memoryStore();
    const guard = guardFixture();
    const runtime = runtimeWith(store, { guard });

    // Promise.all starts both forks before either awaits its store put, so
    // both pre-mint dedupe lists resolve empty and both gestures mint — the
    // exact list-then-put race. The post-persist re-check must delete the
    // newer mint and hand both callers the same surviving app.
    const [first, second] = await Promise.all([
      runtime.pins.fork({ slot: SLOT }, ctx),
      runtime.pins.fork({ slot: SLOT }, ctx),
    ]);

    // The race really happened (both racers minted) and really converged
    // (the loser's row was reaped, not just hidden).
    const operations = guard.audit.map((event) => (event.detail as { operation?: string } | undefined)?.operation);
    expect(operations.filter((operation) => operation === "create")).toHaveLength(2);
    expect(operations.filter((operation) => operation === "delete")).toHaveLength(1);

    expect(second.app.id).toBe(first.app.id);
    expect(first.version.intent).toBe(`Remix the host component "${SLOT}"`);
    expect(second.version.intent).toBe(`Remix the host component "${SLOT}"`);
    const listed = await runtime.list(ctx);
    expect(listed.filter(({ pins }) => pins?.some((pin) => pin.slot === SLOT))).toHaveLength(1);
    expect(listed).toHaveLength(1);
  });
});
