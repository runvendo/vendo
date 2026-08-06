/**
 * ADVERSARIAL probes on the placement verbs (risk round, 2026-08-06).
 *
 * Same fixtures and same shape as `placement-runtime.test.ts` — these are the
 * cases that file does not ask, aimed at the three claims the code makes in
 * prose: that a placement is masked exactly as an app is, that the eviction
 * receipt is true, and that "a stale client can never evict the app that
 * replaced it".
 */
import type { AppDocument, RunContext, StoreAdapter, ToolRegistry } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createApps, type AppsRuntime } from "./index.js";
import { seedGrantRows, storeAccessFixture } from "./testing/app-access-fixture.js";
import {
  authoringAssembler,
  guardFixture,
  memoryStore,
  scriptedLanguageModel,
  seedAppRow,
} from "./testing/index.js";

const ada: RunContext = {
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

describe("a placement read is not an access check (risk round)", () => {
  it("keeps naming an app the caller lost access to, after open() has gone back to not-found", async () => {
    // Mia's app, shared with Ada as a viewer. Ada places it in her own slot —
    // which `place()` allows, correctly: seeing an app is enough to put it on
    // your own page.
    const store = memoryStore();
    await seedAppRow(store, doc("app_mia", "Mia's Q3 severance model"), "user_mia");
    await seedGrantRows(store, "app_mia", { "user:user_ada": "viewer" });
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools,
      catalog: [],
      appAccess: storeAccessFixture(store),
      multiParty: true,
    });
    await runtime.place({ app: "app_mia", slot: "home-hero" }, ada);

    // Mia takes the share back.
    await store.records("vendo_app_grants").delete("ag_app_mia_user:user_ada");

    // §9.4's posture, proved on the read path Ada still has: the app is masked.
    await expect(runtime.open("app_mia", ada)).rejects.toMatchObject({ code: "not-found" });
    expect(await runtime.get("app_mia", ada)).toBeNull();
    expect(await runtime.list(ada)).toEqual([]);
    // …and this is the same subject asking the placements read, which never
    // consults `can()` at all: `entryFor` does a raw `apps.get(row.appId)`.
    // The title of a document Ada may no longer open comes straight back.
    expect(await runtime.placements({}, ada)).toEqual([]);
  });
});

describe("the eviction receipt is read-then-write, with no CAS (risk round)", () => {
  it("loses one of two concurrent places into the same slot and reports no eviction", async () => {
    const store = memoryStore();
    await seedAppRow(store, doc("app_1", "Spending"), ada.principal.subject);
    await seedAppRow(store, doc("app_2", "Savings"), ada.principal.subject);
    const runtime = createApps({ store, guard: guardFixture(), tools, catalog: [] });

    const [first, second] = await Promise.all([
      runtime.place({ app: "app_1", slot: "home-hero" }, ada),
      runtime.place({ app: "app_2", slot: "home-hero" }, ada),
    ]);

    // One of the two DID displace the other — the slot holds one app. Whoever
    // lost was evicted without anybody being told, so the agent's sentence
    // ("nothing was replaced") is false for one of these two callers.
    const held = (await runtime.placements({}, ada))[0]?.app;
    const loser = held === "app_1" ? "app_2" : "app_1";
    expect([first.evicted, second.evicted]).toContain(loser);
  });
});

describe("unplace's 'a stale client can never evict the app that replaced it' (risk round)", () => {
  it("clears the slot the winner just took when a place lands inside unplace's read-then-delete", async () => {
    // The interleaving is forced through the STORE, not through a stub of
    // either verb: the runtime, the placement rows and the store beneath are
    // all the real ones. `delete` on the placements collection is held open
    // until the competing `place` has committed — the exact window
    // `unplace()`'s own comment says cannot be exploited.
    const base = memoryStore();
    let openTheWindow = (): void => {};
    const window = new Promise<void>((resolve) => { openTheWindow = resolve; });
    let held = false;
    const store: StoreAdapter = {
      ...base,
      records(collection) {
        const rows = base.records(collection);
        if (collection !== "vendo_placements") return rows;
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

    await seedAppRow(base, doc("app_1", "Spending"), ada.principal.subject);
    await seedAppRow(base, doc("app_2", "Savings"), ada.principal.subject);
    const runtime = createApps({ store, guard: guardFixture(), tools, catalog: [] });
    await runtime.place({ app: "app_1", slot: "home-hero" }, ada);

    // The stale client's unplace reads the row (app_1), then stalls in delete.
    const stale = runtime.unplace({ app: "app_1", slot: "home-hero" }, ada);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Meanwhile the person places app_2 there.
    expect(await runtime.place({ app: "app_2", slot: "home-hero" }, ada)).toEqual({ evicted: "app_1" });
    openTheWindow();
    await stale;

    expect(await runtime.placements({}, ada)).toEqual([
      { slot: "home-hero", app: "app_2", title: "Savings", status: "ready" },
    ]);
  });
});

describe("vendo_make's `slot`, on a run with nobody there (risk round)", () => {
  const generated = '<App name="Nightly digest"><Text text="Ready"/><Disclaimer reason="Fixture app."/></App>';

  const away: RunContext = {
    principal: ada.principal,
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

  it("rearranges the page anyway — the presence rule catches the pin tool and not this", async () => {
    // `PRESENCE_ONLY_TOOLS` (core/tools.ts) withholds vendo_apps_pin from an
    // unattended run because "a firing that rearranged someone's dashboard
    // while they were away would be a change they never asked for and never
    // saw being made — and, because a placement EVICTS whatever held that
    // slot, one they would come back to without knowing what happened."
    //
    // `vendo_make` is graded `read`, so no projection withholds it and the
    // guard's own defence-in-depth (which keys on the RISK) never fires — and
    // its new `slot` makes that exact write, into the exact same rows.
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
