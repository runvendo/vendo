import type { AppDocument, RunContext, StoreAdapter, ToolRegistry } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createApps, type AppsRuntime } from "./index.js";
import { placementStore } from "./placements.js";
import {
  basicLanguageModel,
  guardFixture,
  memoryStore,
  scriptedAssembler,
  seedAppRow,
} from "./testing/index.js";

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

const doc = (id: string, name: string, overrides: Partial<AppDocument> = {}): AppDocument => ({
  format: "vendo/app@1",
  id,
  name,
  ui: "tree",
  tree: {
    formatVersion: "vendo-genui/v2",
    root: "root",
    nodes: [{ id: "root", component: "Stack", source: "prewired" }],
  },
  ...overrides,
});

const runtimeWith = (store: StoreAdapter) =>
  createApps({ store, guard: guardFixture(), tools, catalog: [] });

describe("AppsRuntime placement verbs", () => {
  it("places an app in a slot and reads it back as ready", async () => {
    const store = memoryStore();
    await seedAppRow(store, doc("app_1", "Spending"), ctx.principal.subject);
    const runtime = runtimeWith(store);

    expect(await runtime.place({ app: "app_1", slot: "home-hero" }, ctx)).toEqual({});
    expect(await runtime.placements({}, ctx)).toEqual([
      { slot: "home-hero", app: "app_1", title: "Spending", status: "ready" },
    ]);
  });

  it("evicts the app already in that slot and names it", async () => {
    const store = memoryStore();
    await seedAppRow(store, doc("app_1", "Spending"), ctx.principal.subject);
    await seedAppRow(store, doc("app_2", "Savings"), ctx.principal.subject);
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
    await seedAppRow(store, doc("app_mia", "Mia's view"), "user_mia");
    const runtime = runtimeWith(store);

    await expect(runtime.place({ app: "app_mia", slot: "home-hero" }, ctx))
      .rejects.toMatchObject({ code: "not-found" });
    await expect(runtime.place({ app: "app_mia", slot: "  " }, ctx))
      .rejects.toMatchObject({ code: "validation" });
    expect(await runtime.placements({}, ctx)).toEqual([]);
  });

  it("unplaces only the row that names the app, and is idempotent", async () => {
    const store = memoryStore();
    await seedAppRow(store, doc("app_1", "Spending"), ctx.principal.subject);
    await seedAppRow(store, doc("app_2", "Savings"), ctx.principal.subject);
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
    await seedAppRow(store, doc("app_1", "Spending"), ctx.principal.subject);
    await seedAppRow(store, doc("app_2", "Savings"), ctx.principal.subject);
    const runtime = runtimeWith(store);
    await runtime.place({ app: "app_1", slot: "home-hero" }, ctx);
    await runtime.place({ app: "app_2", slot: "sidebar" }, ctx);

    expect((await runtime.placements({ slots: ["sidebar"] }, ctx)).map(({ app }) => app)).toEqual(["app_2"]);
    expect((await runtime.placements({}, ctx)).map(({ app }) => app)).toEqual(["app_1", "app_2"]);
  });

  it("reads status off the app record: no record is building, a failed record is failed", async () => {
    const store = memoryStore();
    const runtime = runtimeWith(store);
    const rows = placementStore(store);
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
      store,
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
    await placementStore(store).put(ctx.principal.subject, {
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

  it("deleting an app clears the placements that pointed at it", async () => {
    const store = memoryStore();
    await seedAppRow(store, doc("app_1", "Spending"), ctx.principal.subject);
    const runtime = runtimeWith(store);
    await runtime.place({ app: "app_1", slot: "home-hero" }, ctx);

    await runtime.delete("app_1", ctx);
    expect(await runtime.placements({}, ctx)).toEqual([]);
  });

  it("reports place and unplace to the guard's lifecycle feed", async () => {
    const store = memoryStore();
    const guard = guardFixture();
    await seedAppRow(store, doc("app_1", "Spending"), ctx.principal.subject);
    const runtime = createApps({ store, guard, tools, catalog: [] });

    await runtime.place({ app: "app_1", slot: "home-hero" }, ctx);
    await runtime.unplace({ app: "app_1", slot: "home-hero" }, ctx);

    const operations = guard.audit
      .filter((event) => event.kind === "app-lifecycle")
      .map((event) => (event.detail as { operation?: string }).operation);
    expect(operations).toEqual(["place", "unplace"]);
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

const GENERATED = '<App name="Spending"><Text text="Spending"/><Disclaimer reason="Fixture app."/></App>';

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
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools,
      catalog: [],
      pinBaselines: [{
        slot: "net-worth-card",
        source: "export default function NetWorthCard() { return <strong>$1.2M</strong>; }",
        hash: "sha256:maple-base",
        exportable: false,
        capturedAt: "2026-07-14T12:00:00.000Z",
      }],
    });

    const forked = await runtime.pins.fork({ slot: "net-worth-card" }, ctx);
    expect(forked.app.placements).toBeUndefined();
    expect(await runtime.placements({}, ctx)).toEqual([
      { slot: "net-worth-card", app: forked.app.id, title: forked.app.name, status: "ready" },
    ]);
  });
});
