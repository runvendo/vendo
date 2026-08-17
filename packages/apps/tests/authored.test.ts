import { engineOverAdapter } from "@vendoai/core";
/**
 * Build contract §1.6 / redesign D4 — a FILES-FIRST app is a first-class app.
 *
 * The live E2E defect this closes (2026-08-03): the claude-code harness wrote the
 * app's screen with its own hands, the render seam painted it, and nothing else
 * ever happened — no store row, so the app was absent from the person's list and
 * `vendo_apps_open` masked it as `not-found`, and no query ever ran, so every
 * value on screen read "—" while the host data sat one call away.
 *
 * The checks floor's paint gate is the one door that closes both halves — its own
 * `ok` is what calls `AppsRuntime.authoredScreen` — and these are its rules: the
 * row lands through the SAME writer generation persists with, the queries run
 * through the SAME guard-bound caller `open()` resolves with (so a query the
 * policy gates paints nothing at all, exactly like an app's own read), and an app
 * that already exists keeps everything that is its own history.
 */
import {
  type AppId,
  type RunContext,
  type ToolDescriptor,
  type ToolRegistry,
} from "@vendoai/core";
import {
  SCREEN_FILE,
  warmScreenEngine,
  type AppDocument,
  type ComponentPaintResult,
  type ScreenAssembler,
} from "../src/contract/index.js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { bindTools, guardFixture, type GuardFixture } from "../src/server/testing/guard-fixture.js";
import { memoryStore } from "../src/server/testing/memory-store.js";
import { basicLanguageModel } from "../src/server/testing/scripted-model.js";
import { seedAppRow } from "../src/server/testing/seed-app-row.js";
import { createAppHistory } from "../src/server/persistence/history.js";
import { createApps, seedComponentName, type AppsRuntime, type SeedBaseline } from "../src/server/index.js";
import { seedGrantRows, storeAccessFixture } from "./app-access-fixture.js";

const APP_ID = "app_authored" as AppId;

const screen = (body: string, name = "Spending"): string => `import { Stack, Text, useQuery } from "@vendo/screen";

export default function ${name}() {
  const spend = useQuery("maple_spend_summary");
  return (
    <Stack>
      ${body}
    </Stack>
  );
}
`;

const SPEND = screen(`<Text text={String(spend.total)} />`);

/** The same app, one line further along: a different screen under the SAME name,
 *  which is what a rewrite of a sponsored app looks like to the intent hash. */
const SPEND_MORE = screen(`<Text text={String(spend.total)} />
      <Text text={String(spend.currency)} />`);

/** The same app, renamed — the app's name is its default export's own name. */
const MONEY = screen(`<Text text={String(spend.total)} />`, "Money");

const descriptor: ToolDescriptor = {
  name: "maple_spend_summary",
  title: "Spending summary",
  description: "This month's spending",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  risk: "read",
};

const ctx = (subject = "u1"): RunContext => ({
  principal: { kind: "user", subject },
  venue: "chat",
  presence: "present",
  sessionId: "s1",
});

interface Stand {
  runtime: AppsRuntime;
  store: ReturnType<typeof memoryStore>;
  guard: GuardFixture;
  calls: RunContext[];
  /** §9.9 — every announcement the runtime made through `onDocumentEdit`. */
  edits: Array<{ previous: AppDocument; next: AppDocument; editor: string }>;
  /** Save a screen the way every author does: through the checks floor's paint
   *  gate, whose own `ok` is what upserts the row and stores the source. */
  save: (source: string, runCtx?: RunContext) => Promise<ComponentPaintResult>;
  /**
   * Land something in the window a save brackets: `run` fires ONCE, right after
   * a save reads a row and before it writes. This is the only way to be inside
   * that window from outside, and it is exactly the race a concurrent `edit()`
   * is. `skipReads` lets that many reads pass first, which is how a test picks
   * WHICH part of the window it lands in — 0 is the baseline read, 1 is after
   * the first concurrency check (so inside the history append).
   */
  arm: (run: () => Promise<void>, skipReads?: number) => void;
}

const stand = (options: {
  rules?: Record<string, "run" | "ask" | "block">;
  /** Wire the multi-party half, so a grant row can make a THIRD PARTY an editor. */
  shared?: boolean;
  /** What `vendo sync` captured for this deployment's remixable slots. */
  seedBaselines?: readonly SeedBaseline[];
  /** The edit door's builder, with the model it refuses to run without. A
   *  `reseed` replays its recorded instruction BEFORE it rebases, so the
   *  persistEdit window the two tests below race is only reachable through a
   *  replay that lands. */
  screen?: ScreenAssembler;
} = {}): Stand => {
  const store = memoryStore();
  const guard = guardFixture(options.rules === undefined ? {} : { rules: options.rules });
  const calls: RunContext[] = [];
  const edits: Stand["edits"] = [];
  let armed: { skipReads: number; run: () => Promise<void> } | undefined;
  // The runtime captures its `vendo_apps` collection once; this wrapper hands it
  // an instrumented one so a test can land a write between a save's baseline read
  // and its put.
  const wrapped = {
    ...store,
    records: (collection: string) => {
      const records = store.records(collection);
      if (collection !== "vendo_apps") return records;
      return {
        ...records,
        async get(id: string) {
          const record = await records.get(id);
          if (armed !== undefined) {
            if (armed.skipReads > 0) {
              armed.skipReads -= 1;
            } else {
              const { run } = armed;
              armed = undefined;
              await run();
            }
          }
          return record;
        },
      };
    },
  };
  const host: ToolRegistry = {
    async descriptors() {
      return [descriptor];
    },
    async execute(_call, callCtx) {
      calls.push(callCtx);
      return { status: "ok", output: { total: 4210, currency: "USD" } };
    },
  };
  // THE choke point: the runtime is handed the guard-BOUND registry, exactly as
  // composition hands it one.
  const runtime = createApps({
    store: wrapped,
    guard,
    tools: bindTools(guard, host),
    catalog: [],
    // §9.9's listener, as composition wires it (server.ts → the automations
    // engine's `onDocumentEdit`, which invalidates or re-binds sponsorship).
    onDocumentEdit: async (previous, next, editor) => {
      edits.push({ previous, next, editor });
    },
    ...(options.shared === true ? { appAccess: storeAccessFixture(store) } : {}),
    ...(options.seedBaselines === undefined ? {} : { seedBaselines: [...options.seedBaselines] }),
    ...(options.screen === undefined ? {} : { model: basicLanguageModel(), screen: options.screen }),
  });
  return {
    runtime,
    store,
    guard,
    calls,
    edits,
    save: (source, runCtx = ctx()) => runtime.floor(runCtx).component({ appId: APP_ID, source }),
    arm: (run, skipReads = 0) => {
      armed = { skipReads, run };
    },
  };
};

const rowOf = async (store: Stand["store"], appId = APP_ID): Promise<{
  subject?: string;
  enabled?: boolean;
  doc?: AppDocument;
} | null> => {
  const record = await store.records("vendo_apps").get(appId);
  return record === null ? null : record.data as { subject?: string; enabled?: boolean; doc?: AppDocument };
};

beforeAll(async () => {
  await warmScreenEngine();
});

describe("an app.tsx the harness wrote", () => {
  it("becomes a store row — so it is in the person's Apps list", async () => {
    const { runtime, store, save } = stand();
    expect((await save(SPEND)).ok).toBe(true);

    expect((await runtime.list(ctx())).map((app) => app.id)).toEqual([APP_ID]);
    const row = await rowOf(store);
    expect(row?.subject).toBe("u1");
    expect(row?.doc?.name).toBe("Spending");
    // The screen IS the app: it is stored as the app's own source file, and no
    // tree snapshot rides along to go stale.
    expect(row?.doc?.source?.[SCREEN_FILE]?.text).toBe(SPEND);
    expect(row?.doc?.tree).toBeUndefined();
  }, 60_000);

  it("opens — the tool that answered 'couldn't finish' three times in the live run", async () => {
    const { runtime, save } = stand();
    await save(SPEND);

    const surface = await runtime.open(APP_ID, ctx());
    expect(surface.kind).toBe("tree");
    // And the OPEN path re-runs the screen, resolving the same query for itself.
    expect((surface as { payload: { interactive?: { queries?: unknown } } }).payload.interactive?.queries)
      .toEqual({ maple_spend_summary: { total: 4210, currency: "USD" } });
  }, 60_000);

  it("carries its queries' real data, resolved through the guard-bound registry", async () => {
    const { calls, save } = stand();
    const painted = await save(SPEND);

    expect(painted.ok).toBe(true);
    if (!painted.ok) throw new Error("unreachable");
    // What the renderer re-boots the screen from — the answers the gauntlet's own
    // execution got, not a second resolution nobody watched.
    expect(painted.interactive.queries).toEqual({ maple_spend_summary: { total: 4210, currency: "USD" } });
    // The app venue, the app's id, and the caller's own principal — an app's read
    // is attributed as an app's read, never as a bare chat tool call.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ venue: "app", appId: APP_ID, principal: { subject: "u1" } });
  }, 60_000);

  it("respects the guard on every query — a gated read paints NOTHING", async () => {
    const { guard, store, save } = stand({ rules: { maple_spend_summary: "ask" } });
    const painted = await save(SPEND);

    // …and the person is TOLD, rather than being shown a screen of "—" that reads
    // as "you have no spending". A screen whose data did not arrive is not a
    // screen: the gauntlet ran the query, watched it be refused, and says so.
    expect(painted.ok).toBe(false);
    if (painted.ok) throw new Error("unreachable");
    expect(painted.blocking.join("\n")).toContain("maple_spend_summary");
    expect(painted.blocking.join("\n")).toContain("approval");
    // One card, parked exactly as an app's own read would park it — the floor has
    // no second execution path that could skip it.
    expect(guard.approvals).toHaveLength(1);
    // A refused paint earns no row: the app that cannot render is not in the list.
    expect(await rowOf(store)).toBeNull();
  }, 60_000);

  it("re-saves in place, keeping what is the app's own history", async () => {
    const { runtime, store, save } = stand();
    await save(SPEND);
    // Something only the app knows about itself, written by another door.
    await store.records("vendo_apps").put({
      id: APP_ID,
      data: { subject: "u1", enabled: true, doc: { ...(await rowOf(store))!.doc!, automations: ["atm_digest"] } },
      refs: { subject: "u1" },
    });

    await save(MONEY);

    const row = await rowOf(store);
    expect(row?.doc?.name).toBe("Money");
    expect(row?.doc?.automations).toEqual(["atm_digest"]);
    expect(await runtime.list(ctx())).toHaveLength(1);
  }, 60_000);

  it("never rewrites an app the caller may not edit", async () => {
    const { store, edits, save } = stand();
    const theirs: AppDocument = { format: "vendo/app@1", id: APP_ID, name: "Theirs" };
    await seedAppRow(engineOverAdapter(store), theirs, "u2");

    // `/user/**` is its subject's at every level, so the workspace will land this
    // file in u1's own mount. This door is the only thing standing between that
    // and u2's app.
    const painted = await save(SPEND, ctx("u1"));

    expect((await rowOf(store))?.doc).toEqual(theirs);
    expect((await rowOf(store))?.subject).toBe("u2");
    // Nothing about the other person's app is read, written, versioned or
    // ANNOUNCED: an announcement over a foreign row would invalidate a
    // sponsorship u2 holds, on a file u1 wrote in their own mount.
    expect(edits).toEqual([]);
    expect((await store.records(`vendo:app-history:${APP_ID}`).list()).records).toEqual([]);
    // The person still sees their own file painted, with their own data.
    expect(painted.ok).toBe(true);
  }, 60_000);

  it("does not need a model — files-first never calls the engine", async () => {
    const { runtime, save } = stand();
    // `stand()` composes no `model:`, so a generation door would refuse here.
    await expect(runtime.create({ prompt: "anything" }, ctx())).rejects.toThrow(/requires a model/);
    expect((await save(SPEND)).ok).toBe(true);
  }, 60_000);
});

/**
 * Build contract §9.9 — a files-first rewrite is a change to what the app IS, so
 * it passes through the SAME announcement `persistEdit` makes. It has
 * to: a screen save keeps the app's `automations` list verbatim, so the intent
 * hash a sponsorship was minted over does not move when a third party rewrites
 * the file — the fire-time hash check cannot see this change, and this hook is
 * the only thing that can.
 */
describe("§9.9 — the announcement a files-first save owes", () => {
  it("announces a third party's rewrite of a sponsored app, under THEIR subject", async () => {
    const { store, edits, save } = stand({ shared: true });
    await save(SPEND, ctx("u1"));
    await seedAppRow(engineOverAdapter(store), { ...(await rowOf(store))!.doc!, automations: ["atm_digest"] }, "u1", true);
    // u2 holds editor on u1's app (a shared automation) and rewrites the file.
    await seedGrantRows(store, APP_ID, { "user:u2": "editor" });

    await save(SPEND_MORE, ctx("u2"));

    expect(edits).toHaveLength(1);
    // The invalidation keys on exactly this: the editor is not the sponsor.
    expect(edits[0]?.editor).toBe("u2");
    // And it could key on nothing else — every input to the intent hash (name,
    // automations, declared tools) came through the rewrite unchanged.
    expect(edits[0]?.next.name).toBe(edits[0]?.previous.name);
    expect(edits[0]?.next.automations).toEqual(["atm_digest"]);
    // §9.5 — the row keeps its owner.
    expect((await rowOf(store))?.subject).toBe("u1");
  }, 60_000);

  it("announces the sponsor's OWN rename, so their automation is re-bound not killed", async () => {
    const { store, edits, save } = stand();
    await save(SPEND);
    await seedAppRow(engineOverAdapter(store), { ...(await rowOf(store))!.doc!, automations: ["atm_digest"] }, "u1", true);

    await save(MONEY);

    // A rename DOES move the hash — without the announcement the automation would
    // stop at its next fire for an edit its own sponsor made.
    expect(edits).toHaveLength(1);
    expect(edits[0]?.editor).toBe("u1");
    expect(edits[0]?.next.name).toBe("Money");
  }, 60_000);

  it("announces nothing for the FIRST save — that is a create, and it says so", async () => {
    const { edits, guard, save } = stand();
    await save(SPEND);

    expect(edits).toEqual([]);
    expect(guard.audit.filter((event) => event.kind === "app-lifecycle")).toHaveLength(1);
  }, 60_000);
});

describe("the version a files-first save leaves", () => {
  it("records the state a rewrite replaced", async () => {
    const { runtime, save } = stand();
    await save(SPEND);
    // The first save is a create: there is no earlier state to keep.
    expect(await runtime.history(APP_ID, ctx()).list()).toEqual([]);

    await save(MONEY);

    const versions = await runtime.history(APP_ID, ctx()).list();
    expect(versions).toHaveLength(1);
    expect(versions[0]?.intent).toBe("Saved app.tsx");
  }, 60_000);

  it("spends no version on a re-save that changed nothing", async () => {
    const { runtime, edits, save } = stand();
    await save(SPEND);
    await save(SPEND);

    // The history is capped at 50: a version for the state the app is already
    // in would push a real one out.
    expect(await runtime.history(APP_ID, ctx()).list()).toEqual([]);
    // And §9.9 says nothing either: the app is not different, invalidation is
    // terminal, so announcing an identical re-save would kill a live sponsorship
    // for a change that does not exist. The skill saves on a timer, so this is
    // the common case, not the corner.
    expect(edits).toEqual([]);
  }, 60_000);
});

/**
 * A replay that LANDS and writes nothing — what a `reseed` needs before it may
 * rebase, and all it needs, since the two tests below are about the write the
 * rebase itself makes. A builder that saved a screen would append that save's
 * own version and the ledgers they assert would be measuring it.
 */
const REPLAYS_NOTHING: ScreenAssembler = { assemble: async () => ({ kind: "assembled" }) };

/** The `vendo_apps` reads a re-seed makes before persistEdit's first concurrency
 *  check: its own row read, the edit door's, the assembler brief's, and the one
 *  the assembled edit reads back through, then persistEdit's row-subject read.
 *  Skipping exactly these lands the concurrent write inside the append. */
const READS_BEFORE_RESEED_PERSISTS = 5;

/**
 * The cap is 50, and every append is speculative until the write it was appended
 * FOR lands (a refusal discards it). Pruning inside the append therefore charged
 * the app's OLDEST real version for a write that never happened: at the cap, one
 * refused save destroyed v0 and left 49. Fifty conflicts erased the whole
 * recorded history of an app that never changed once.
 */
describe("a refused write at the history cap", () => {
  /** Fill the log to exactly the cap with versions of the app as it stands. */
  const fillToCap = async (store: Stand["store"]): Promise<string[]> => {
    const doc = (await rowOf(store))!.doc!;
    const history = createAppHistory(engineOverAdapter(store));
    for (let index = 1; index <= 50; index += 1) {
      await history.append(APP_ID, doc, {
        at: new Date(1_754_000_000_000 + index).toISOString(),
        intent: `Edit ${index}`,
        rung: 1,
      });
    }
    const ids = (await store.records(`vendo:app-history:${APP_ID}`).list()).records.map(({ id }) => id);
    expect(ids).toHaveLength(50);
    return ids.sort();
  };

  const versionIds = async (store: Stand["store"]): Promise<string[]> =>
    (await store.records(`vendo:app-history:${APP_ID}`).list()).records.map(({ id }) => id).sort();

  it("costs the SAVE path no version at all", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { store, arm, save } = stand();
      await save(SPEND);
      const stored = (await rowOf(store))!.doc!;
      const before = await fillToCap(store);
      // The edit lands after the first concurrency check, so the append runs and
      // the second check refuses the write — the round-7 case, now at the cap.
      arm(async () => {
        await seedAppRow(engineOverAdapter(store), { ...stored, description: "the person's own edit" }, "u1");
      }, 1);

      await save(MONEY);

      // The save was refused (the person's own edit stands)…
      expect((await rowOf(store))?.doc?.description).toBe("the person's own edit");
      expect(errors.mock.calls.map(String).join(" ")).toContain("app not saved");
      // …and the log is EXACTLY what it was: the speculative version taken back,
      // and the oldest real one never charged for it.
      expect(await versionIds(store)).toEqual(before);
    } finally {
      errors.mockRestore();
    }
  }, 60_000);

  it("costs the RE-SEED path none either (persistEdit shares the rule)", async () => {
    const slot = "dashboard.header";
    const { runtime, store, arm, save } = stand({
      seedBaselines: [{
        slot,
        source: "export default function Header() {\n  return <h1>Maple Bank</h1>;\n}",
        hash: "sha256:host-NEW",
        exportable: false,
        capturedAt: "2026-08-03T00:00:00.000Z",
      }],
      screen: REPLAYS_NOTHING,
    });
    await save(SPEND);
    // A seeded app sitting on the OLD baseline, so the re-seed below has real
    // work to do. `reseed` is the persistEdit path a stand can drive without a
    // box or an armed automation.
    await seedAppRow(engineOverAdapter(store), {
      ...(await rowOf(store))!.doc!,
      seed: { component: slot, baseline: "sha256:host-old", instruction: "make it mine" },
      components: { [seedComponentName(slot)]: { source: "export default () => null;", origin: "seeded" as const } },
    }, "u1");
    const stored = (await rowOf(store))!.doc!;
    const before = await fillToCap(store);
    arm(async () => {
      await seedAppRow(engineOverAdapter(store), { ...stored, description: "the person's own edit" }, "u1");
    }, READS_BEFORE_RESEED_PERSISTS);

    await expect(runtime.seed.reseed({ appId: APP_ID }, ctx())).rejects.toMatchObject({
      code: "conflict",
    });

    expect(await versionIds(store)).toEqual(before);
  }, 60_000);

  it("still charges the cap for a save that LANDS", async () => {
    // The other half of the same rule, and the half nothing pinned: moving the
    // prune out of the append must not lose it. Dropping the `pruneHistory` call
    // this path makes leaves the log growing past 50 forever — the skill saves
    // `app.tsx` on a timer, so this path is the one that reaches the cap first.
    const { runtime, store, save } = stand();
    await save(SPEND);
    await fillToCap(store);

    await save(SPEND_MORE);

    const versions = await runtime.history(APP_ID, ctx()).list();
    expect(versions).toHaveLength(50);
    // The newest is this save, and the oldest real version paid for it.
    expect(versions[0]?.intent).toBe("Saved app.tsx");
    expect(versions.at(-1)?.intent).toBe("Edit 2");
  }, 60_000);
});

describe("a save computed over a row that changed under it", () => {
  it("is refused rather than reverting the edit that landed", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { store, edits, arm, runtime, save } = stand();
      await save(SPEND);
      const stored = (await rowOf(store))!.doc!;
      // What a UI `edit()` lands in the window: this save's baseline is now stale,
      // and the document it computed carries the PRE-edit description forward.
      arm(async () => {
        await seedAppRow(engineOverAdapter(store), { ...stored, description: "the person's own edit" }, "u1");
      });

      const painted = await save(MONEY);

      const row = await rowOf(store);
      expect(row?.doc?.description).toBe("the person's own edit");
      expect(row?.doc?.name).toBe("Spending");
      // Nothing announced and no version minted for a write that never landed.
      expect(edits).toEqual([]);
      expect(await runtime.history(APP_ID, ctx()).list()).toEqual([]);
      // Never silent…
      expect(errors.mock.calls.map(String).join(" ")).toContain("app not saved");
      // …and never a reason to withhold the view the person is already looking at.
      expect(painted.ok).toBe(true);
    } finally {
      errors.mockRestore();
    }
  }, 60_000);

  it("is refused when it lands DURING the version append, not only before it", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { store, edits, arm, runtime, save } = stand();
      await save(SPEND);
      const stored = (await rowOf(store))!.doc!;
      // One read later than the test above: the baseline read and the first
      // concurrency check both pass, and the edit lands while the history append
      // is in flight. A single check would have written the pre-edit document
      // straight over it — the append is a store round trip, so the whole of it
      // sits inside the window.
      arm(async () => {
        await seedAppRow(engineOverAdapter(store), { ...stored, description: "the person's own edit" }, "u1");
      }, 1);

      await save(MONEY);

      const row = await rowOf(store);
      expect(row?.doc?.description).toBe("the person's own edit");
      expect(row?.doc?.name).toBe("Spending");
      expect(edits).toEqual([]);
      expect(errors.mock.calls.map(String).join(" ")).toContain("app not saved");
      // The append already ran — and the refusal takes it back. Its snapshot
      // predates BOTH writes, so leaving it would put a version in the trail
      // for a state that was never the past.
      expect(await runtime.history(APP_ID, ctx()).list()).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  }, 60_000);

  it("does not conflict with a run of saves in the same turn", async () => {
    const { store, edits, runtime, save } = stand();
    await save(SPEND);
    // The skill saves once per group: each save re-reads its own baseline, so a
    // rapid sequence never conflicts with itself.
    await save(SPEND_MORE);
    await save(SPEND);
    await save(MONEY);

    expect((await rowOf(store))?.doc?.name).toBe("Money");
    expect(edits).toHaveLength(3);
    expect(await runtime.history(APP_ID, ctx()).list()).toHaveLength(3);
  }, 60_000);

  /**
   * The same append-then-check bracket on the path that has a CALLER: every
   * `persistEdit` write. A refusal there threw before and left its version
   * behind too, and a version whose write never landed describes a state that
   * never existed. The fork gesture is the one persistEdit path a model-less
   * stand can drive (it is deterministic by design).
   */
  it("leaves no version behind when a RE-SEED is refused mid-write", async () => {
    const slot = "dashboard.header";
    const { runtime, store, arm, save } = stand({
      seedBaselines: [{
        slot,
        source: "export default function Header() {\n  return <h1>Maple Bank</h1>;\n}",
        hash: "sha256:host-NEW",
        exportable: false,
        capturedAt: "2026-08-03T00:00:00.000Z",
      }],
      screen: REPLAYS_NOTHING,
    });
    await save(SPEND);
    await seedAppRow(engineOverAdapter(store), {
      ...(await rowOf(store))!.doc!,
      seed: { component: slot, baseline: "sha256:host-old", instruction: "make it mine" },
      components: { [seedComponentName(slot)]: { source: "export default () => null;", origin: "seeded" as const } },
    }, "u1");
    const stored = (await rowOf(store))!.doc!;
    // The reads before persistEdit's own pass, then the edit lands right after
    // its first concurrency check — so the append runs and the second check
    // refuses the write.
    arm(async () => {
      await seedAppRow(engineOverAdapter(store), { ...stored, description: "the person's own edit" }, "u1");
    }, READS_BEFORE_RESEED_PERSISTS);

    await expect(runtime.seed.reseed({ appId: APP_ID }, ctx())).rejects.toMatchObject({
      code: "conflict",
    });

    expect((await rowOf(store))?.doc?.description).toBe("the person's own edit");
    // The refused re-seed left the app on its ORIGINAL baseline.
    expect((await rowOf(store))?.doc?.seed?.baseline).toBe("sha256:host-old");
    expect(await runtime.history(APP_ID, ctx()).list()).toEqual([]);
  }, 60_000);
});
