/**
 * ADVERSARIAL round 2 on the placement rows (re-check, 2026-08-06), against the
 * pointer + token-keyed live row the first round's fixes introduced.
 *
 * Round 1's six findings are closed and their cases are green; nothing here
 * re-litigates them. These are the cases the NEW shape opens, plus the two
 * round-1 "plausible" items confirmed now that there is a tree to run them in.
 *
 * Same fixtures as `placement-runtime.test.ts` and `placement-risk.test.ts`:
 * the real runtime over a real store, and the rows read back out of the store.
 */
import type { AppDocument, RunContext, StoreAdapter, ToolRegistry } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createApps } from "./index.js";
import {
  PLACEMENTS_COLLECTION,
  PLACEMENT_SLOTS_COLLECTION,
  placementStore,
} from "./placements.js";
import { guardFixture, memoryStore, seedAppRow } from "./testing/index.js";

const ada: RunContext = {
  principal: { kind: "user", subject: "user_ada" },
  venue: "app",
  presence: "present",
  sessionId: "session_ada",
};
const mia: RunContext = {
  ...ada,
  principal: { kind: "user", subject: "user_mia" },
  sessionId: "session_mia",
};

const tools: ToolRegistry = {
  async descriptors() { return []; },
  async execute() { return { status: "error", error: { code: "not-found", message: "no tools" } }; },
};

const doc = (id: string, name: string): AppDocument => ({
  format: "vendo/app@1",
  id,
  name,
  ui: "tree",
  tree: {
    formatVersion: "vendo-genui/v2",
    root: "root",
    nodes: [{ id: "root", component: "Stack", source: "prewired" }],
  },
});

/** The count `placements.ts` calls "exactly one row per live placement, which
 *  is what the seam readers count" — and which `placement-rows.test.ts` pins. */
const liveRows = async (store: StoreAdapter, subject: string) =>
  (await store.records(PLACEMENTS_COLLECTION).list({ refs: { subject } })).records;

const pointerApps = async (store: StoreAdapter, subject: string): Promise<string[]> =>
  (await store.records(PLACEMENT_SLOTS_COLLECTION).list({ refs: { subject } })).records
    .map((record) => (record.data as { appId?: string }).appId ?? "");

describe("a placement that dies between its live row and its pointer", () => {
  it("leaves no live row behind for the retry to pile on top of", async () => {
    // `place()` writes the live row FIRST and swings the pointer second, which
    // is what keeps a reader from ever seeing the slot empty mid-replace. The
    // cost is that anything which stops the pointer write strands the live row:
    // nothing names it, nothing reads it, and nothing ever collects it.
    //
    // The blip is injected at the store's own `atomic` seam — the real adapter
    // interface, and the reason `place()` has a retry loop at all. A client
    // that retries (the picker, the pin ceremony, the poller's next tick) adds
    // one more stranded row every time, unbounded, each holding the subject,
    // the app id and the timestamp.
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
    await seedAppRow(base, doc("app_1", "Spending"), ada.principal.subject);
    const runtime = createApps({ store, guard: guardFixture(), tools, catalog: [] });

    await expect(runtime.place({ app: "app_1", slot: "home-hero" }, ada)).rejects.toThrow();
    await runtime.place({ app: "app_1", slot: "home-hero" }, ada);

    // The slot itself is right — the pointer is the only arbiter, and it names
    // the second attempt. It is the collection underneath that is not.
    expect(await runtime.placements({}, ada)).toHaveLength(1);
    expect(await liveRows(base, ada.principal.subject)).toHaveLength(1);
  });
});

describe("what a deleted app leaves in the slot rows", () => {
  it("takes its pointer with it, not just its live row", async () => {
    // Before the pointer split, `delete` removed the placement outright. Now it
    // clears the live row and leaves the pointer holding the dead app's id, its
    // placedBy subject and its timestamp — and nothing else in the codebase
    // ever deletes a pointer, so one accumulates per slot the person ever used
    // and only a full subject erase reaches it.
    const store = memoryStore();
    await seedAppRow(store, doc("app_1", "Spending"), ada.principal.subject);
    const runtime = createApps({ store, guard: guardFixture(), tools, catalog: [] });
    await runtime.place({ app: "app_1", slot: "home-hero" }, ada);

    await runtime.delete("app_1", ada);

    expect(await runtime.placements({}, ada)).toEqual([]);
    expect(await liveRows(store, ada.principal.subject)).toHaveLength(0);
    expect(await pointerApps(store, ada.principal.subject)).toEqual([]);
  });

  it("clears the rows OTHER people hold on it, not only the deleter's", async () => {
    // `delete` sweeps `placementRows.list(ctx.principal.subject)` — the
    // DELETER's rows. Mia owns a shared app, Ada placed it on her own page, Mia
    // deletes it: Ada's row survives with no record behind it, which `entryFor`
    // reads as a build in flight and then, past the build window, as `failed`.
    //
    // A failed slot REPLACES the host's own markup (ruled by design, and the
    // only way out is a person tapping "Clear this slot"), so one person
    // deleting their own app leaves an error card standing on another person's
    // page. The §9.4 mask added this round does not catch it: the masking arm
    // runs only where an app record exists, and here there is none.
    const store = memoryStore();
    await seedAppRow(store, doc("app_mia", "Mia's view"), mia.principal.subject);
    await placementStore(store).put(ada.principal.subject, {
      slot: "home-hero",
      appId: "app_mia",
      placedBy: ada.principal.subject,
      placedAt: new Date().toISOString(),
    });
    const runtime = createApps({ store, guard: guardFixture(), tools, catalog: [] });

    await runtime.delete("app_mia", mia);

    expect(await runtime.placements({}, ada)).toEqual([]);
  });
});

describe("the pointer a clear takes with it is the pointer it read", () => {
  it("leaves the replacement holding the slot when a place lands inside the pointer's read-then-delete", async () => {
    // The token check in front of the pointer delete is a READ, and the delete
    // it guards names the slot, not the token — so a place that lands in the
    // gap between them swings the pointer to a NEW token and the delete takes
    // that pointer down instead. The replacement's live row survives with
    // nothing naming it, and the slot the person just filled reads empty.
    //
    // Forced through the STORE, like the round-1 unplace race: the runtime, the
    // placement rows and the store beneath are all real, and both verbs run for
    // real. The pointer read is held open from the moment the clear has taken
    // its own live row down — which is exactly where that gap opens.
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

    await seedAppRow(base, doc("app_1", "Spending"), ada.principal.subject);
    await seedAppRow(base, doc("app_2", "Savings"), ada.principal.subject);
    const runtime = createApps({ store, guard: guardFixture(), tools, catalog: [] });
    await runtime.place({ app: "app_1", slot: "home-hero" }, ada);

    // The clear reads the pointer (app_1's token), then stalls before removing it.
    const clear = runtime.unplace({ app: "app_1", slot: "home-hero" }, ada);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Meanwhile the person puts app_2 there — a new token on the same pointer.
    await runtime.place({ app: "app_2", slot: "home-hero" }, ada);
    openTheWindow();
    await clear;

    expect(await runtime.placements({}, ada)).toEqual([
      { slot: "home-hero", app: "app_2", title: "Savings", status: "ready" },
    ]);
    expect(await pointerApps(base, ada.principal.subject)).toEqual(["app_2"]);
    expect(await liveRows(base, ada.principal.subject)).toHaveLength(1);
  });
});

describe("the slot string a caller places with is the slot string it can read", () => {
  it("answers a `slots` filter that is spelled exactly as the write was", async () => {
    // `requireSlot` trims on every WRITE (place/unplace/create); the read path
    // (`placements({slots})` → `placementStore.list`) does not trim at all, so
    // the same string round-trips to nothing. The wire hides it — its query
    // parser trims each name — which is exactly why it is invisible until a
    // host calls the runtime or the client's `placements([...])` directly.
    const store = memoryStore();
    await seedAppRow(store, doc("app_1", "Spending"), ada.principal.subject);
    const runtime = createApps({ store, guard: guardFixture(), tools, catalog: [] });
    await runtime.place({ app: "app_1", slot: " home-hero " }, ada);

    expect(await runtime.placements({ slots: [" home-hero "] }, ada)).toHaveLength(1);
  });
});
