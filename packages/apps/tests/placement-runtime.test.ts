import { engineOverAdapter } from "@vendoai/core";
import type {
  RunContext,
  StoreAdapter,
  ToolRegistry,
} from "@vendoai/core";
import type {
  AppDocument,
} from "../src/contract/index.js";
import { describe, expect, it } from "vitest";
import { createApps, type AppsRuntime } from "../src/server/index.js";
import {
  PLACEMENTS_COLLECTION,
  PLACEMENT_SLOTS_COLLECTION,
  placementStore,
} from "../src/server/persistence/placements.js";
import { seedGrantRows, storeAccessFixture } from "./app-access-fixture.js";
import { authoringAssembler, scriptedAssembler, scriptedScreenAssembler } from "../src/server/testing/screen-assembler.js";
import { FIXTURE_SCREEN } from "../src/server/testing/screen-document.js";
import { guardFixture } from "../src/server/testing/guard-fixture.js";
import { memoryStore } from "../src/server/testing/memory-store.js";
import { basicLanguageModel, scriptedLanguageModel } from "../src/server/testing/scripted-model.js";
import { seedAppRow } from "../src/server/testing/seed-app-row.js";

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_ada" },
  venue: "app",
  presence: "present",
  sessionId: "session_ada",
};

const mia: RunContext = {
  ...ctx,
  principal: { kind: "user", subject: "user_mia" },
  sessionId: "session_mia",
};

const tools: ToolRegistry = {
  async descriptors() { return []; },
  async execute() { return { status: "error", error: { code: "not-found", message: "no tools" } }; },
};

const doc = (id: string, name: string, overrides: Partial<AppDocument> = {}): AppDocument => ({
  format: "vendo/app@1",
  id,
  name,
  ui: "tree",
  ...overrides,
});

const runtimeWith = (store: StoreAdapter) =>
  createApps({ store, guard: guardFixture(), tools, catalog: [] });

/** `placements.ts` keeps exactly one LIVE row per live placement — the count
 *  the seam readers take. Read straight out of the collection, so a row the
 *  pointer no longer names still shows up here. */
const liveRows = async (store: StoreAdapter, subject: string) =>
  (await store.records(PLACEMENTS_COLLECTION).list({ refs: { subject } })).records;

/** The apps the pointer rows name — the other half of the two-row split. */
const pointerApps = async (store: StoreAdapter, subject: string): Promise<string[]> =>
  (await store.records(PLACEMENT_SLOTS_COLLECTION).list({ refs: { subject } })).records
    .map((record) => (record.data as { appId?: string }).appId ?? "");

describe("AppsRuntime placement verbs", () => {
  it("places an app in a slot and reads it back as ready", async () => {
    const store = memoryStore();
    await seedAppRow(engineOverAdapter(store), doc("app_1", "Spending"), ctx.principal.subject);
    const runtime = runtimeWith(store);

    expect(await runtime.place({ app: "app_1", slot: "home-hero" }, ctx)).toEqual({});
    expect(await runtime.placements({}, ctx)).toEqual([
      { slot: "home-hero", app: "app_1", title: "Spending", status: "ready" },
    ]);
  });

  it("evicts the app already in that slot and names it", async () => {
    const store = memoryStore();
    await seedAppRow(engineOverAdapter(store), doc("app_1", "Spending"), ctx.principal.subject);
    await seedAppRow(engineOverAdapter(store), doc("app_2", "Savings"), ctx.principal.subject);
    const runtime = runtimeWith(store);

    await runtime.place({ app: "app_1", slot: "home-hero" }, ctx);
    expect(await runtime.place({ app: "app_2", slot: "home-hero" }, ctx)).toEqual({ evicted: "app_1" });
    // One row, not two: the slot holds exactly one app.
    expect(await runtime.placements({}, ctx)).toEqual([
      { slot: "home-hero", app: "app_2", title: "Savings", status: "ready" },
    ]);
    // Re-placing the SAME app evicts nobody.
    expect(await runtime.place({ app: "app_2", slot: "home-hero" }, ctx)).toEqual({});
  });

  it("masks an app the caller cannot see, and refuses an empty slot", async () => {
    const store = memoryStore();
    await seedAppRow(engineOverAdapter(store), doc("app_mia", "Mia's view"), "user_mia");
    const runtime = runtimeWith(store);

    await expect(runtime.place({ app: "app_mia", slot: "home-hero" }, ctx))
      .rejects.toMatchObject({ code: "not-found" });
    await expect(runtime.place({ app: "app_mia", slot: "  " }, ctx))
      .rejects.toMatchObject({ code: "validation" });
    expect(await runtime.placements({}, ctx)).toEqual([]);
  });

  it("stops naming a placed app once the caller's grant is taken back", async () => {
    // §9.4 on the placement READ as well as the write. Ada is a viewer on Mia's
    // app and places it in her own slot — which `place()` allows, correctly:
    // seeing an app is enough to put it on your own page. When Mia takes the
    // share back, `entryFor` re-checks `holds(..., "viewer")` per row, so the
    // slot reads empty for Ada rather than handing back the title of a document
    // she can no longer open. The three other read paths are checked alongside
    // it, because a placement that disagreed with them would be the leak.
    const store = memoryStore();
    await seedAppRow(engineOverAdapter(store), doc("app_mia", "Mia's Q3 severance model"), "user_mia");
    await seedGrantRows(store, "app_mia", { "user:user_ada": "viewer" });
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools,
      catalog: [],
      appAccess: storeAccessFixture(store),
    });
    await runtime.place({ app: "app_mia", slot: "home-hero" }, ctx);

    await store.records("vendo_app_grants").delete("ag_app_mia_user:user_ada");

    await expect(runtime.open("app_mia", ctx)).rejects.toMatchObject({ code: "not-found" });
    expect(await runtime.get("app_mia", ctx)).toBeNull();
    expect(await runtime.list(ctx)).toEqual([]);
    expect(await runtime.placements({}, ctx)).toEqual([]);
  });

  it("unplaces only the row that names the app, and is idempotent", async () => {
    const store = memoryStore();
    await seedAppRow(engineOverAdapter(store), doc("app_1", "Spending"), ctx.principal.subject);
    await seedAppRow(engineOverAdapter(store), doc("app_2", "Savings"), ctx.principal.subject);
    const runtime = runtimeWith(store);
    await runtime.place({ app: "app_1", slot: "home-hero" }, ctx);

    // A stale client asking to unplace an app that no longer holds the slot
    // must not clear somebody else's placement.
    await runtime.unplace({ app: "app_2", slot: "home-hero" }, ctx);
    expect(await runtime.placements({}, ctx)).toHaveLength(1);

    await runtime.unplace({ app: "app_1", slot: "home-hero" }, ctx);
    await runtime.unplace({ app: "app_1", slot: "home-hero" }, ctx);
    expect(await runtime.placements({}, ctx)).toEqual([]);
  });

  it("answers only the slots asked for", async () => {
    const store = memoryStore();
    await seedAppRow(engineOverAdapter(store), doc("app_1", "Spending"), ctx.principal.subject);
    await seedAppRow(engineOverAdapter(store), doc("app_2", "Savings"), ctx.principal.subject);
    const runtime = runtimeWith(store);
    await runtime.place({ app: "app_1", slot: "home-hero" }, ctx);
    await runtime.place({ app: "app_2", slot: "sidebar" }, ctx);

    expect((await runtime.placements({ slots: ["sidebar"] }, ctx)).map(({ app }) => app)).toEqual(["app_2"]);
    expect((await runtime.placements({}, ctx)).map(({ app }) => app)).toEqual(["app_1", "app_2"]);
  });

  it("normalizes a slot name the same way on the read as on the write", async () => {
    // `requireSlot` runs on both sides — the writes (place/unplace/create) and
    // `placements({ slots })`. Trimming on one side only would mean the exact
    // string a caller placed with round-trips to nothing, invisibly: the wire's
    // query parser trims each name itself, so only a host calling the runtime
    // or the client's `placements([...])` directly would ever see it.
    const store = memoryStore();
    await seedAppRow(engineOverAdapter(store), doc("app_1", "Spending"), ctx.principal.subject);
    const runtime = runtimeWith(store);
    await runtime.place({ app: "app_1", slot: " home-hero " }, ctx);

    expect(await runtime.placements({ slots: [" home-hero "] }, ctx)).toHaveLength(1);
  });

  it("reads status off the app record: no record is building, a failed record is failed", async () => {
    const store = memoryStore();
    const runtime = runtimeWith(store);
    const rows = placementStore(engineOverAdapter(store));
    const subject = ctx.principal.subject;

    // A build in flight: the row exists, the app record does not (yet).
    await rows.put(subject, {
      slot: "home-hero",
      appId: "app_building",
      placedBy: subject,
      placedAt: new Date().toISOString(),
    });
    expect(await runtime.placements({}, ctx)).toEqual([
      { slot: "home-hero", app: "app_building", title: "", status: "building" },
    ]);

    // The terminal failed record the build watchdog / failBuild persists.
    await seedAppRow(
      engineOverAdapter(store),
      doc("app_failed", "Show my spending", {
        buildFailed: { reason: "the model quit", retryable: true, at: "2026-08-05T12:00:00.000Z" },
      }),
      subject,
    );
    await rows.put(subject, {
      slot: "sidebar",
      appId: "app_failed",
      placedBy: subject,
      placedAt: new Date().toISOString(),
    });
    expect(await runtime.placements({ slots: ["sidebar"] }, ctx)).toEqual([
      { slot: "sidebar", app: "app_failed", title: "Show my spending", status: "failed" },
    ]);
  });

  it("stops calling a vanished app 'building' once the build window has passed", async () => {
    const store = memoryStore();
    const runtime = runtimeWith(store);
    await placementStore(engineOverAdapter(store)).put(ctx.principal.subject, {
      slot: "home-hero",
      appId: "app_gone",
      placedBy: ctx.principal.subject,
      placedAt: "2020-01-01T00:00:00.000Z",
    });
    // No record and no build window left: the app is gone, not forming — a
    // slot must never park on a skeleton forever.
    expect(await runtime.placements({}, ctx)).toEqual([
      { slot: "home-hero", app: "app_gone", title: "", status: "failed" },
    ]);
  });

  it("deleting an app clears the placements that pointed at it, pointer and all", async () => {
    const store = memoryStore();
    await seedAppRow(engineOverAdapter(store), doc("app_1", "Spending"), ctx.principal.subject);
    const runtime = runtimeWith(store);
    await runtime.place({ app: "app_1", slot: "home-hero" }, ctx);

    await runtime.delete("app_1", ctx);
    expect(await runtime.placements({}, ctx)).toEqual([]);
    // BOTH rows of the split go. Nothing else in the tree ever collects a
    // pointer, so one left holding a dead app's id would accumulate per slot
    // the person ever used and only a full subject erase would reach it.
    expect(await liveRows(store, ctx.principal.subject)).toHaveLength(0);
    expect(await pointerApps(store, ctx.principal.subject)).toEqual([]);
  });

  it("deleting a shared app clears the rows OTHER people hold on it", async () => {
    // The sweep is by APP, not by the deleter's subject: Mia owns the app, Ada
    // placed it on her own page. A row left behind has no record to resolve, so
    // `entryFor` reads it as a build in flight and then — past the build window
    // — as `failed`, which REPLACES the host's own markup. One person deleting
    // their own app must not leave an error card standing on somebody else's.
    const store = memoryStore();
    await seedAppRow(engineOverAdapter(store), doc("app_mia", "Mia's view"), mia.principal.subject);
    await placementStore(engineOverAdapter(store)).put(ctx.principal.subject, {
      slot: "home-hero",
      appId: "app_mia",
      placedBy: ctx.principal.subject,
      placedAt: new Date().toISOString(),
    });
    const runtime = runtimeWith(store);

    await runtime.delete("app_mia", mia);

    expect(await runtime.placements({}, ctx)).toEqual([]);
  });

  it("strands no live row when the pointer swing fails and the caller retries", async () => {
    // `place()` writes the live row FIRST and swings the pointer second, so a
    // reader never sees the slot empty mid-replace. The cost is that anything
    // which stops the pointer write would strand the live row — nothing names
    // it, nothing reads it, nothing collects it — so the swing takes its own
    // row back out on the way past. Without that, every retry (the picker, the
    // pin ceremony, the poller's next tick) would add one more row, unbounded.
    //
    // The blip is injected at the store's own `atomic` seam: the real adapter
    // interface, and the reason `place()` retries at all.
    const base = memoryStore();
    let blip = true;
    const store: StoreAdapter = {
      ...base,
      records(collection) {
        const rows = base.records(collection);
        const atomic = rows.atomic;
        if (collection !== PLACEMENT_SLOTS_COLLECTION || atomic === undefined) return rows;
        return {
          ...rows,
          atomic: {
            ...atomic,
            async insertIfAbsent(input) {
              if (blip) {
                blip = false;
                throw new Error("transient store blip");
              }
              return await atomic.insertIfAbsent(input);
            },
          },
        };
      },
    } as StoreAdapter;
    await seedAppRow(engineOverAdapter(base), doc("app_1", "Spending"), ctx.principal.subject);
    const runtime = runtimeWith(store);

    await expect(runtime.place({ app: "app_1", slot: "home-hero" }, ctx)).rejects.toThrow();
    await runtime.place({ app: "app_1", slot: "home-hero" }, ctx);

    expect(await runtime.placements({}, ctx)).toHaveLength(1);
    expect(await liveRows(base, ctx.principal.subject)).toHaveLength(1);
  });

  it("reports place and unplace to the guard's lifecycle feed", async () => {
    const store = memoryStore();
    const guard = guardFixture();
    await seedAppRow(engineOverAdapter(store), doc("app_1", "Spending"), ctx.principal.subject);
    const runtime = createApps({ store, guard, tools, catalog: [] });

    await runtime.place({ app: "app_1", slot: "home-hero" }, ctx);
    await runtime.unplace({ app: "app_1", slot: "home-hero" }, ctx);

    const operations = guard.audit
      .filter((event) => event.kind === "app-lifecycle")
      .map((event) => (event.detail as { operation?: string }).operation);
    expect(operations).toEqual(["place", "unplace"]);
  });
});

describe("two writers racing for one slot", () => {
  it("names the loser in the winner's eviction receipt when two places land at once", async () => {
    // The receipt is only true if the read and the write are ONE decision:
    // read-then-put let both callers answer "nothing was replaced" while one of
    // them was silently displaced. `swingPointer` is a CAS loop over the
    // pointer, so the loser sees the winner's revision, retries against it, and
    // exactly one of the two receipts names the app that lost the slot.
    const store = memoryStore();
    await seedAppRow(engineOverAdapter(store), doc("app_1", "Spending"), ctx.principal.subject);
    await seedAppRow(engineOverAdapter(store), doc("app_2", "Savings"), ctx.principal.subject);
    const runtime = runtimeWith(store);

    const [first, second] = await Promise.all([
      runtime.place({ app: "app_1", slot: "home-hero" }, ctx),
      runtime.place({ app: "app_2", slot: "home-hero" }, ctx),
    ]);

    const held = (await runtime.placements({}, ctx))[0]?.app;
    const loser = held === "app_1" ? "app_2" : "app_1";
    expect([first.evicted, second.evicted]).toContain(loser);
  });

  it("leaves the replacement holding the slot when a place lands inside a stale unplace", async () => {
    // A stale client can never evict the app that replaced it. The live row is
    // keyed on the placement's TOKEN and a token is never reused, so the delete
    // this unplace issues can only ever address its OWN placement — even when
    // the competing place commits after the row was read.
    //
    // Forced through the STORE, not through a stub of either verb: the runtime,
    // the placement rows and the store beneath are all real. The live-row delete
    // is held open until the competing `place` has committed.
    const base = memoryStore();
    let openTheWindow = (): void => {};
    const window = new Promise<void>((resolve) => { openTheWindow = resolve; });
    let held = false;
    const store: StoreAdapter = {
      ...base,
      records(collection) {
        const rows = base.records(collection);
        if (collection !== PLACEMENTS_COLLECTION) return rows;
        return {
          ...rows,
          async delete(id: string) {
            if (!held) {
              held = true;
              await window;
            }
            return await rows.delete(id);
          },
        };
      },
    } as StoreAdapter;

    await seedAppRow(engineOverAdapter(base), doc("app_1", "Spending"), ctx.principal.subject);
    await seedAppRow(engineOverAdapter(base), doc("app_2", "Savings"), ctx.principal.subject);
    const runtime = runtimeWith(store);
    await runtime.place({ app: "app_1", slot: "home-hero" }, ctx);

    // The stale client's unplace reads the row (app_1), then stalls in delete.
    const stale = runtime.unplace({ app: "app_1", slot: "home-hero" }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Meanwhile the person places app_2 there.
    expect(await runtime.place({ app: "app_2", slot: "home-hero" }, ctx)).toEqual({ evicted: "app_1" });
    openTheWindow();
    await stale;

    expect(await runtime.placements({}, ctx)).toEqual([
      { slot: "home-hero", app: "app_2", title: "Savings", status: "ready" },
    ]);
  });

  it("leaves the replacement's POINTER standing when a place lands inside the same window", async () => {
    // The other half of that race, one row down. The token check in front of the
    // pointer removal is a READ, so it has to ride the WRITE too: a delete keyed
    // on the slot alone would take down the brand-new pointer a competing place
    // installed in the gap, orphaning its live row and leaving the slot the
    // person just filled reading empty. `claim` with no replacement is the store
    // contract's compare-and-delete, keyed on the row that read saw.
    //
    // Same discipline as above: both verbs run for real, and the pointer read is
    // held open from the moment the clear has taken its own live row down.
    const base = memoryStore();
    let openTheWindow = (): void => {};
    const window = new Promise<void>((resolve) => { openTheWindow = resolve; });
    let clearing = false;
    let held = false;
    const store: StoreAdapter = {
      ...base,
      records(collection) {
        const rows = base.records(collection);
        if (collection === PLACEMENTS_COLLECTION) {
          return {
            ...rows,
            async delete(id: string) {
              await rows.delete(id);
              clearing = true;
            },
          };
        }
        if (collection !== PLACEMENT_SLOTS_COLLECTION) return rows;
        return {
          ...rows,
          async get(id: string) {
            const record = await rows.get(id);
            if (clearing && !held) {
              held = true;
              await window;
            }
            return record;
          },
        };
      },
    } as StoreAdapter;

    await seedAppRow(engineOverAdapter(base), doc("app_1", "Spending"), ctx.principal.subject);
    await seedAppRow(engineOverAdapter(base), doc("app_2", "Savings"), ctx.principal.subject);
    const runtime = runtimeWith(store);
    await runtime.place({ app: "app_1", slot: "home-hero" }, ctx);

    // The clear reads the pointer (app_1's token), then stalls before removing it.
    const clear = runtime.unplace({ app: "app_1", slot: "home-hero" }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Meanwhile the person puts app_2 there — a new token on the same pointer.
    await runtime.place({ app: "app_2", slot: "home-hero" }, ctx);
    openTheWindow();
    await clear;

    expect(await runtime.placements({}, ctx)).toEqual([
      { slot: "home-hero", app: "app_2", title: "Savings", status: "ready" },
    ]);
    expect(await pointerApps(base, ctx.principal.subject)).toEqual(["app_2"]);
    expect(await liveRows(base, ctx.principal.subject)).toHaveLength(1);
  });
});

describe("vendo_make's `slot` on a run with nobody there", () => {
  const generated = `import { Stack, Text } from "@vendo/screen";

export default function NightlyDigest() {
  return (
    <Stack gap={12}>
      <Text text="Ready" variant="heading" />
    </Stack>
  );
}
`;

  const away: RunContext = {
    principal: ctx.principal,
    venue: "automation",
    presence: "away",
    sessionId: "session_nightly",
  };

  /** The assembly engine, exactly as `agent-tools.test.ts` composes it. */
  const assembling = (): AppsRuntime => {
    const runtime: AppsRuntime = createApps({
      store: memoryStore(),
      guard: guardFixture(),
      tools,
      catalog: [],
      model: scriptedLanguageModel(generated),
      screen: authoringAssembler(() => runtime, generated),
    });
    return runtime;
  };

  it("still builds what it was asked for, and takes no slot", async () => {
    // The slot, and ONLY the slot, needs a person there: it claims a place on
    // somebody's page and EVICTS whatever held it, which is a change they would
    // come back to without ever having seen it made. `vendo_make` is graded
    // `read`, so neither the tool projection nor the guard's risk-keyed refusal
    // withholds it — the rule lives in the door itself, which drops `slot` on an
    // unattended run rather than refusing the build.
    const runtime = assembling();

    const outcome = await runtime.agentTools().execute({
      id: "call_nightly_make",
      tool: "vendo_make",
      args: { request: "my spending this month", slot: "dashboard.hero" },
    }, away);

    expect(outcome.status).toBe("ok");
    expect(await runtime.placements({}, away)).toEqual([]);
  });
});

/** Poll until the condition holds, with NO inner budget on purpose: the test's
 *  own timeout is the hang detector, and a tighter inner limit is a second,
 *  invisible speed limit that reports a product bug when the machine is busy. */
const until = async <T>(read: () => Promise<T>, ok: (value: T) => boolean): Promise<T> => {
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const GENERATED = `import { Stack, Text } from "@vendo/screen";

export default function Spending() {
  return (
    <Stack gap={12}>
      <Text text="Spending" variant="heading" />
    </Stack>
  );
}
`;

/** The one engine, held until the test releases it — which is what makes "the
 *  slot shows the build forming" observable without a sleep. It is the ASSEMBLER
 *  that is gated, because assembly is where every `create` starts. */
const gatedRuntime = (store: StoreAdapter, gate?: Promise<void>): AppsRuntime => {
  let runtime: AppsRuntime;
  runtime = createApps({
    store,
    guard: guardFixture(),
    tools,
    catalog: [],
    model: basicLanguageModel(),
    screen: scriptedAssembler(() => runtime, async () => {
      await gate;
      return GENERATED;
    }),
  });
  return runtime;
};

describe("a slot-targeted create claims its slot at mint (B1)", () => {
  it("shows the slot BUILDING while the engine runs, then READY when it lands", async () => {
    const store = memoryStore();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runtime = gatedRuntime(store, gate);

    const building = runtime.create({ prompt: "Show my spending", slot: "home-hero" }, ctx);
    // The row exists before a single token does.
    await until(() => runtime.placements({}, ctx), rows => rows[0]?.status === "building");

    release();
    const app = await building;
    expect(await runtime.placements({}, ctx)).toEqual([
      { slot: "home-hero", app: app.id, title: app.name, status: "ready" },
    ]);
  });

  it("leaves the slot alone when the create names none", async () => {
    const store = memoryStore();
    const runtime = gatedRuntime(store);
    await runtime.create({ prompt: "Show my spending" }, ctx);
    expect(await runtime.placements({}, ctx)).toEqual([]);
  });
});

describe("the empty-slot Remix gesture places its mint", () => {
  it("writes a placement row instead of a document placement", async () => {
    const store = memoryStore();
    let runtime: AppsRuntime;
    // The gesture's first edit has to LAND: a remix whose build never happened
    // carries the same terminal marker any other failed build does, and the
    // slot reads it as "failed" rather than "ready".
    runtime = createApps({
      store,
      guard: guardFixture(),
      tools,
      catalog: [],
      model: basicLanguageModel(),
      screen: scriptedScreenAssembler(() => runtime, () =>
        "export default function Screen() {\n  return <strong>$1.2M</strong>;\n}\n"),
      seedBaselines: [{
        slot: "net-worth-card",
        source: "export default function NetWorthCard() { return <strong>$1.2M</strong>; }",
        hash: "sha256:maple-base",
        exportable: false,
        capturedAt: "2026-07-14T12:00:00.000Z",
        // No ported half, no ✦ — so the gesture this test places needs one.
        ported: { source: FIXTURE_SCREEN, tools: [], holes: [] },
      }],
    });

    const forked = await runtime.seed.from(
      { component: "net-worth-card", slot: "net-worth-card", instruction: "show it as a chart" },
      ctx,
    );
    expect(await runtime.placements({}, ctx)).toEqual([
      { slot: "net-worth-card", app: forked.id, title: forked.name, status: "ready" },
    ]);
  });
});
