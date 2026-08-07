import { compileWire, type AppDocument, type RunContext, type StoreAdapter, type ToolRegistry } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createAppHistory } from "./history.js";
import { createApps, type AppsRuntime, type PinBaseline } from "./index.js";
import { pinComponentName } from "./pins.js";
import { appVersionHash } from "./version-hash.js";
import {
  basicLanguageModel,
  guardFixture,
  memoryStore,
  scriptedAssembler,
  seedAppRow,
  type AssemblerAnswer,
} from "./testing/index.js";

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_rebase" },
  venue: "app",
  presence: "present",
  sessionId: "session_rebase",
};

const tools: ToolRegistry = {
  async descriptors() { return []; },
  async execute() { return { status: "error", error: { code: "not-found", message: "missing" } }; },
};

const SLOT = "net-worth-card";
const COMPONENT = pinComponentName(SLOT);
const OLD_SOURCE = `export default function NetWorthCard() {
  return <strong>$1.2M</strong>;
}`;
const NEW_SOURCE = `export default function NetWorthCard() {
  return <article><span>Net worth</span><strong>$1.2M</strong></article>;
}`;
const REPLAYED_SOURCE = NEW_SOURCE.replace("$1.2M", "$1.2M in green");

const baseline = (source: string, hash: string): PinBaseline => ({
  slot: SLOT,
  source,
  hash,
  exportable: false,
  capturedAt: "2026-07-14T12:00:00.000Z",
});

const seedDoc = (id = "app_rebase"): AppDocument => ({
  format: "vendo/app@1",
  id,
  name: "Maple overview",
  ui: "tree",
  tree: {
    formatVersion: "vendo-genui/v2",
    root: "root",
    nodes: [{ id: "root", component: "Stack", source: "prewired" }],
  },
});

/** One turn of the builder, as the test sees it: what it was asked, and the
 *  pinned source it was looking at when it was asked. */
interface AssemblyTurn { instruction: string; source: string | undefined }

/** The one line the pinned card renders, rewritten. */
const relabelled = (source: string, label: string): string => source.replace(/\$1\.2M[^<]*/, label);

/**
 * What one instruction does to this app. Every instruction the trail in these
 * tests is made of is one of two changes: a new label on the pinned card (the
 * remix a drift is about), or a new title (a change that touches no pin, so a
 * rebase must never replay it). Anything else is an ask this builder cannot
 * carry out.
 */
const rewriteFor = (instruction: string): { label?: string; name?: string } | undefined => {
  const pinned = /^Pinned edit \d+: /.exec(instruction);
  if (pinned !== null) return { label: instruction.slice(pinned[0].length) };
  if (instruction === "Show it in green") return { label: "$1.2M in green" };
  if (instruction === "Rename the app") return { name: "Maple overview (renamed)" };
  if (instruction === "Rename while drifted") return { name: "Edited while drifted" };
  return undefined;
};

/**
 * The ONE builder, as a fixture.
 *
 * It opens the app's own document, rewrites it and saves the whole thing back
 * through `authored` — the real write, the real undo point, the real recorded
 * pin intent. Only the choice of new document stands in for a live screen
 * agent, which is what makes a replayed trail here a real replayed trail.
 *
 * `override` is how a test says this builder cannot do something: an
 * `unavailable`, or a document that does not compile.
 */
const buildingScreen = (
  runtime: () => AppsRuntime,
  options: BuilderOptions,
) => scriptedAssembler(runtime, (request, current) => {
  const source = current?.components?.[COMPONENT];
  options.seen?.push({ instruction: request.request, source });
  const overridden = options.override?.(request.request);
  if (overridden !== undefined) return overridden;
  const rewrite = current === null ? undefined : rewriteFor(request.request);
  if (current === null || rewrite === undefined) {
    return { kind: "unavailable", why: `nothing in "${request.request}" is a change I can make to this app` };
  }
  const island = source === undefined
    ? ""
    : `\n  <${COMPONENT} />\n  <Island name="${COMPONENT}">${
      rewrite.label === undefined ? source : relabelled(source, rewrite.label)
    }</Island>`;
  return `<App name="${rewrite.name ?? current.name}">${island}\n</App>`;
});

interface BuilderOptions {
  /** Every turn the builder was given, in order. */
  seen?: AssemblyTurn[];
  /** What this builder answers instead of doing the work. */
  override?: (instruction: string) => AssemblerAnswer | undefined;
}

/** A runtime whose builder is the fixture above, on whichever baseline the host
 *  has captured. The model is only here because a runtime without one refuses to
 *  edit or rebase at all — nothing on these paths generates. */
const runtimeOn = (
  store: StoreAdapter,
  options: BuilderOptions & {
    captured?: PinBaseline;
    guard?: ReturnType<typeof guardFixture>;
  } = {},
): AppsRuntime => {
  let runtime: AppsRuntime;
  runtime = createApps({
    store,
    guard: options.guard ?? guardFixture(),
    tools,
    catalog: [],
    model: basicLanguageModel(),
    screen: buildingScreen(() => runtime, options),
    ...(options.captured === undefined ? {} : { pinBaselines: [options.captured] }),
  });
  return runtime;
};

const OLD_BASELINE = (): PinBaseline => baseline(OLD_SOURCE, "sha256:maple-old");
const NEW_BASELINE = (): PinBaseline => baseline(NEW_SOURCE, "sha256:maple-new");

/** Fork the pin and record one pinned edit + one non-pin edit on the OLD
 *  baseline. The fork itself is the deterministic gesture (pins.fork) — the
 *  generator lost the fork decision entirely — and every later change is one
 *  ordinary edit through the one builder. */
const seedForkedHistory = async (
  store: StoreAdapter,
  extraPinnedEdits: string[] = [],
): Promise<string> => {
  const app = seedDoc();
  await seedAppRow(store, app, ctx.principal.subject);
  const runtime = runtimeOn(store, { captured: OLD_BASELINE() });
  const forked = await runtime.pins.fork({ appId: app.id, slot: SLOT }, ctx);
  expect(forked.app.pins).toEqual([{ slot: SLOT, base: "sha256:maple-old" }]);
  const green = await runtime.edit(app.id, "Show it in green", ctx);
  expect(green.failure).toBeUndefined();
  for (const [index, marker] of extraPinnedEdits.entries()) {
    const extra = await runtime.edit(app.id, `Pinned edit ${index + 1}: ${marker}`, ctx);
    expect(extra.failure).toBeUndefined();
  }
  const renamed = await runtime.edit(app.id, "Rename the app", ctx);
  expect(renamed.failure).toBeUndefined();
  return app.id;
};

/** The intent pins.fork records for the gesture — the first intent on the
 *  trail by construction, and the one the rebase never replays. */
const FORK_INTENT = `Remix the host component "${SLOT}"`;

/** What that row must SAY it is: the only kind that can vouch for the pinned
 *  component having started as the captured baseline. */
const FORK_KIND = "fork";

/** Fork the pin deterministically on the OLD baseline, with no edits on top. */
const seedBareFork = async (store: StoreAdapter, id: string): Promise<AppsRuntime> => {
  const app = seedDoc(id);
  await seedAppRow(store, app, ctx.principal.subject);
  const runtime = runtimeOn(store, { captured: OLD_BASELINE() });
  await runtime.pins.fork({ appId: app.id, slot: SLOT }, ctx);
  return runtime;
};

/** The same store, reopened after the host changed the component and resynced. */
const rebasedRuntime = (
  store: StoreAdapter,
  options: BuilderOptions = {},
): AppsRuntime => runtimeOn(store, { ...options, captured: NEW_BASELINE() });

describe("06-apps §8 — drift surfacing", () => {
  it("reports drift on pins.drift, open() payloads, and edit results after a host resync", async () => {
    const store = memoryStore();
    const appId = await seedForkedHistory(store);
    const runtime = rebasedRuntime(store);

    const expectedDrift = [{
      slot: SLOT,
      component: COMPONENT,
      baseHash: "sha256:maple-old",
      baselineHash: "sha256:maple-new",
      reason: "baseline-changed",
    }];
    await expect(runtime.pins.drift(appId, ctx)).resolves.toEqual(expectedDrift);

    const surface = await runtime.open(appId, ctx);
    if (surface.kind !== "tree") throw new Error("expected tree surface");
    expect((surface.payload as { pinDrift?: unknown }).pinDrift).toEqual(expectedDrift);

    const edited = await runtime.edit(appId, "Rename while drifted", ctx);
    expect(edited.failure).toBeUndefined();
    expect(edited.driftedPins).toEqual(expectedDrift);
  });

  it("keeps non-drifted payloads clean and strips a forged document pinDrift", async () => {
    const store = memoryStore();
    const forged: AppDocument = {
      ...seedDoc("app_forged_drift"),
      pins: [{ slot: SLOT, base: "sha256:maple-old" }],
      components: { [COMPONENT]: OLD_SOURCE },
    };
    (forged.tree as { pinDrift?: unknown }).pinDrift = [{ slot: "forged", component: "Forged", baseHash: "x", reason: "baseline-missing" }];
    (forged.tree as unknown as { nodes: unknown[] }).nodes = [
      { id: "root", component: "Stack", source: "prewired", children: ["worth"] },
      { id: "worth", component: COMPONENT, source: "generated" },
    ];
    await seedAppRow(store, forged, ctx.principal.subject);
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools,
      catalog: [],
      pinBaselines: [baseline(OLD_SOURCE, "sha256:maple-old")],
    });

    await expect(runtime.pins.drift(forged.id, ctx)).resolves.toEqual([]);
    const surface = await runtime.open(forged.id, ctx);
    if (surface.kind !== "tree") throw new Error("expected tree surface");
    expect("pinDrift" in (surface.payload as object)).toBe(false);
  });
});

describe("06-apps §8 — pin rebase via intent replay", () => {
  it("re-forks the new baseline, replays the recorded pin intents in order, and skips non-pin intents", async () => {
    const store = memoryStore();
    const appId = await seedForkedHistory(store, ["$1.2M underlined"]);
    const seen: AssemblyTurn[] = [];
    const runtime = rebasedRuntime(store, { seen });
    const before = await runtime.get(appId, ctx);
    const versionsBefore = await runtime.history(appId, ctx).list();

    const result = await runtime.pins.rebase({ appId, slot: SLOT }, ctx);

    if (result.status !== "rebased") throw new Error(`expected rebased, got ${JSON.stringify(result)}`);
    expect(result.slot).toBe(SLOT);
    expect(result.baseHash).toBe("sha256:maple-new");
    expect(result.replayed).toEqual(["Show it in green", "Pinned edit 1: $1.2M underlined"]);
    expect(result.app.pins).toEqual([{ slot: SLOT, base: "sha256:maple-new" }]);
    expect(result.app.components?.[COMPONENT]).toBe(REPLAYED_SOURCE.replace("in green", "underlined"));
    // The fork intent is never replayed (the re-fork is mechanical), non-pin
    // intents are never replayed, and each replay opens the app as the previous
    // one left it — starting from the NEW baseline source under the pin.
    const instructions = seen.map(({ instruction }) => instruction);
    expect(seen).toHaveLength(2);
    expect(instructions[0]).toBe("Show it in green");
    expect(seen[0]?.source).toContain("<article><span>Net worth</span>");
    expect(instructions[1]).toContain("Pinned edit 1");
    expect(seen[1]?.source).toContain("$1.2M in green");
    // Neither is ever what a replay turn was asked to do.
    expect(instructions).not.toContain("Rename the app");
    expect(instructions).not.toContain(FORK_INTENT);

    // The rebase persisted a NEW version: content hash moved, drift cleared.
    expect(appVersionHash(result.app)).not.toBe(appVersionHash(before!));
    await expect(runtime.get(appId, ctx)).resolves.toEqual(result.app);
    await expect(runtime.pins.drift(appId, ctx)).resolves.toEqual([]);
    const versions = await runtime.history(appId, ctx).list();
    // Four writes, because a replay is a REAL write through the one builder now:
    // the mechanical re-fork, one per replayed intent, and the rebase's own
    // version on top of them.
    expect(versions).toHaveLength(versionsBefore.length + 4);
    expect(versions[0]).toEqual(result.version);
    expect(result.version.intent).toContain(`Rebase remixed ${SLOT}`);

    // The rebase itself records no intent — and the trail still reads as the
    // fork followed by the user's own instructions in order, so a future rebase
    // replays the same instructions again. Each replay re-records the intent it
    // carried out, because the write that did it was an ordinary edit.
    const trail = await createAppHistory(store).pinIntents(appId, SLOT);
    expect(trail.map(({ intent }) => intent)).toEqual([
      FORK_INTENT,
      "Show it in green",
      "Pinned edit 1: $1.2M underlined",
      "Show it in green",
      "Pinned edit 1: $1.2M underlined",
    ]);
  });

  it("mechanically re-forks when the trail holds only the fork intent (nothing to replay)", async () => {
    const store = memoryStore();
    const app = seedDoc("app_fork_only");
    await seedAppRow(store, app, ctx.principal.subject);
    const original = runtimeOn(store, { captured: OLD_BASELINE() });
    await original.pins.fork({ appId: app.id, slot: SLOT }, ctx);
    expect((await original.edit(app.id, "Rename the app", ctx)).failure).toBeUndefined();

    const seen: AssemblyTurn[] = [];
    const runtime = rebasedRuntime(store, { seen });
    const result = await runtime.pins.rebase({ appId: app.id, slot: SLOT }, ctx);

    // The fork was a verbatim copy of the old baseline with nothing replayable
    // on top, so the rebase is the mechanical re-fork alone: the pin now
    // carries the NEW baseline source verbatim, and the builder was never asked
    // for anything.
    if (result.status !== "rebased") throw new Error("expected a rebased result");
    expect(result.replayed).toEqual([]);
    expect(seen).toEqual([]);
    expect(result.app.pins).toEqual([{ slot: SLOT, base: "sha256:maple-new" }]);
    expect(result.app.components?.[COMPONENT]).toBe(NEW_SOURCE);
    // The non-pin edit rode through untouched.
    expect(result.app.name).toBe("Maple overview (renamed)");
    await expect(runtime.pins.drift(app.id, ctx)).resolves.toEqual([]);
  });

  it("re-forks a host update that switched to a named export with a synthesized default export (ENG-348)", async () => {
    const store = memoryStore();
    await seedBareFork(store, "app_named_rebase");
    const app = seedDoc("app_named_rebase");

    const namedSource = NEW_SOURCE.replace("export default function", "export function");
    const runtime = runtimeOn(store, { captured: baseline(namedSource, "sha256:maple-named") });
    const result = await runtime.pins.rebase({ appId: app.id, slot: SLOT }, ctx);

    if (result.status !== "rebased") throw new Error("expected a rebased result");
    expect(result.app.pins).toEqual([{ slot: SLOT, base: "sha256:maple-named" }]);
    // The mechanical re-fork ships through pinForkSource, exactly like
    // fork-pin, so the named-export capture still renders in the jail.
    expect(result.app.components?.[COMPONENT])
      .toBe(`${namedSource}\nexport { NetWorthCard as default };\n`);
  });

  it("refuses to rebase onto a baseline with no detectable component export, loudly", async () => {
    const store = memoryStore();
    await seedBareFork(store, "app_unexported_rebase");
    const app = seedDoc("app_unexported_rebase");

    const runtime = runtimeOn(store, { captured: baseline("const NetWorthCard = () => null;", "sha256:maple-unexported") });
    await expect(runtime.pins.rebase({ appId: app.id, slot: SLOT }, ctx)).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("no default export"),
    });
  });

  it("drops an in-client approval by construction: the rebased version needs re-approval", async () => {
    const store = memoryStore();
    const appId = await seedForkedHistory(store);
    const runtime = rebasedRuntime(store);
    await runtime.inClient.approve({ appId, approvedBy: "host-review" }, ctx);
    await expect(runtime.inClient.verdict(appId, ctx)).resolves.toMatchObject({ granted: true });

    const result = await runtime.pins.rebase({ appId, slot: SLOT }, ctx);

    expect(result.status).toBe("rebased");
    await expect(runtime.inClient.verdict(appId, ctx)).resolves.toEqual({
      granted: false,
      versionHash: appVersionHash((result as { app: AppDocument }).app),
      reason: "version-changed",
    });
  });

  it("undo rewinds the rebase step by step, back to the pre-rebase version, and keeps the replay trail intact", async () => {
    const store = memoryStore();
    const appId = await seedForkedHistory(store);
    const runtime = rebasedRuntime(store);
    const before = await runtime.get(appId, ctx);
    const versionsBefore = await runtime.history(appId, ctx).list();
    const result = await runtime.pins.rebase({ appId, slot: SLOT }, ctx);
    expect(result.status).toBe("rebased");

    // Every replay is a real write through the one builder now, so a rebase is
    // as many undo points as it made writes: the re-fork, each replayed intent,
    // and the rebase's own version. Rewinding it walks back through all of them.
    const spent = (await runtime.history(appId, ctx).list()).length - versionsBefore.length;
    expect(spent).toBe(3);
    let undone: AppDocument | undefined;
    for (let step = 0; step < spent; step += 1) undone = await runtime.history(appId, ctx).undo();
    expect(undone).toEqual(before);
    await expect(runtime.get(appId, ctx)).resolves.toEqual(before);
    await expect(runtime.pins.drift(appId, ctx)).resolves.toMatchObject([{ slot: SLOT }]);
    const trail = await store.records(`vendo:app-pin-intents:${appId}`).list();
    expect(trail.records).toHaveLength(2);

    // The intact trail supports rebasing again after the undo.
    const again = await runtime.pins.rebase({ appId, slot: SLOT }, ctx);
    expect(again.status).toBe("rebased");
  });

  it("fails closed on a replay failure: reports the split and persists nothing", async () => {
    const store = memoryStore();
    const appId = await seedForkedHistory(store, ["$1.2M underlined"]);
    // The second replayed intent is one this builder cannot carry out — the card
    // it is about is missing — and a builder that cannot make the change says so
    // rather than guessing.
    const runtime = rebasedRuntime(store, {
      override: (instruction) => instruction.startsWith("Pinned edit")
        ? { kind: "unavailable", why: "the card that change is about is missing from this app" }
        : undefined,
    });
    const before = await runtime.get(appId, ctx);

    const result = await runtime.pins.rebase({ appId, slot: SLOT }, ctx);

    if (result.status !== "failed") throw new Error("expected a failed rebase");
    expect(result.replayed).toEqual(["Show it in green"]);
    expect(result.failed.intent).toBe("Pinned edit 1: $1.2M underlined");
    expect(result.failed.issues).toEqual(expect.arrayContaining([expect.stringContaining("missing")]));
    expect(result.remaining).toEqual([]);
    // The app is exactly as it was: the abandoned rebase put the document back,
    // so the person keeps their remix on the old baseline and stays drifted.
    await expect(runtime.get(appId, ctx)).resolves.toEqual(before);
    await expect(runtime.pins.drift(appId, ctx)).resolves.toMatchObject([{ slot: SLOT }]);
  });

  it("fails closed when a replayed trail intent does not produce a valid document", async () => {
    const store = memoryStore();
    const appId = await seedForkedHistory(store);
    // execution-v2 Wave 3 — every rebase replay rides the ONE builder (the
    // server code lane is gone). A trail intent whose assembly is not a valid
    // `.vendo` document fails the rebase, never half-applying it.
    await store.records(`vendo:app-pin-intents:${appId}`).put({
      id: "pinint_tampered",
      data: {
        slot: SLOT,
        at: "2026-07-15T12:00:00.000Z",
        intent: "Persist the card to the database",
        // A replayable row — the trail's own words. (Without the kind it is a
        // pre-discriminator row, which fails the whole rebase closed instead;
        // that is the test below, and it is not what this one is about.)
        kind: "edit",
        versionId: "ver_tampered",
        seq: 99,
      },
      refs: { slot: SLOT },
    });
    const runtime = rebasedRuntime(store, {
      override: (instruction) => instruction === "Persist the card to the database"
        ? JSON.stringify({ rung: 2, files: [{ path: "/app/index.js", content: "export {}" }] })
        : undefined,
    });
    const before = await runtime.get(appId, ctx);

    const result = await runtime.pins.rebase({ appId, slot: SLOT }, ctx);

    if (result.status !== "failed") throw new Error("expected a failed rebase");
    expect(result.replayed).toEqual(["Show it in green"]);
    expect(result.failed.intent).toBe("Persist the card to the database");
    expect(result.failed.issues.length).toBeGreaterThan(0);
    await expect(runtime.get(appId, ctx)).resolves.toEqual(before);
  });

  it("refuses a trail whose remix came from a files-first SAVE, so that remix survives the drift", async () => {
    // THE mainline sequence, end to end: `pins.fork` is the Remix gesture and
    // files-first is how apps are written by default, so the trail reads
    // [fork, "Saved app.vendo"]. Requiring intents[0] to BE the fork does not
    // close this: the fork is there, and the receipt behind it went to the
    // builder as a replay instruction. The re-fork had already overwritten the
    // pinned component with the pristine new baseline, so whatever the builder
    // did with "Saved app.vendo" persisted as a "rebased" app WITHOUT the
    // person's remix — measured: status "rebased", replayed ["Saved app.vendo"],
    // remix gone.
    const store = memoryStore();
    const app = seedDoc("app_files_first_remix");
    await seedAppRow(store, app, ctx.principal.subject);
    const authoring = runtimeOn(store, { captured: OLD_BASELINE() });
    await authoring.pins.fork({ appId: app.id, slot: SLOT }, ctx);

    // The person keeps working in the FILE: they rewrite the remixed component
    // and the harness saves `app.vendo`. Their work now exists in exactly one
    // place — the stored document.
    const remixWire = `<App name="Maple overview">
  <${COMPONENT} />
  <Island name="${COMPONENT}">export default function ${COMPONENT}() { return "Ada's own remix"; }</Island>
</App>`;
    await authoring.authored({ appId: app.id, compiled: compileWire(remixWire) }, ctx);
    expect((await authoring.get(app.id, ctx))?.components?.[COMPONENT]).toContain("Ada's own remix");
    expect((await createAppHistory(store).pinIntents(app.id, SLOT)).map(({ kind }) => kind))
      .toEqual([FORK_KIND, "touch"]);

    // The host ships a new version of that component and re-syncs: drift. The
    // builder here would LAND anything it was asked (a save receipt included),
    // so a rebase that decided to replay the receipt would get all the way to a
    // persisted "rebased" app.
    const seen: AssemblyTurn[] = [];
    const resynced = rebasedRuntime(store, {
      seen,
      override: () => `<App name="Maple overview">
  <${COMPONENT} />
  <Island name="${COMPONENT}">${REPLAYED_SOURCE}</Island>
</App>`,
    });
    await expect(resynced.pins.drift(app.id, ctx)).resolves.toMatchObject([{ slot: SLOT }]);

    // The refusal is the only honest answer: a save receipt is not an
    // instruction, and the change it stands for cannot be replayed onto the new
    // baseline. Refusing costs one manual remix; accepting costs the remix.
    await expect(resynced.pins.rebase({ appId: app.id, slot: SLOT }, ctx)).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("no recorded edit trail"),
      detail: { reason: "unreplayable-trail", unreplayable: ["Saved app.vendo"] },
    });
    // Nothing was asked of the builder, nothing was written, and the person's
    // own component is still theirs…
    expect(seen).toEqual([]);
    const after = await resynced.get(app.id, ctx);
    expect(after?.components?.[COMPONENT]).toContain("Ada's own remix");
    expect(after?.pins).toEqual([{ slot: SLOT, base: "sha256:maple-old" }]);
    // …and the pin stays honestly drifted, which is what offers the remix again.
    await expect(resynced.pins.drift(app.id, ctx)).resolves.toMatchObject([{ slot: SLOT }]);
  });

  it("fails closed on a legacy trail row that cannot say what it is", async () => {
    // Rows written before the discriminator existed prove nothing: this one may
    // be one of the user's instructions or a save receipt, and the two have
    // opposite consequences. Refusing costs a manual remix; guessing "edit" is
    // how a remix gets overwritten by the pristine host component.
    const store = memoryStore();
    const appId = await seedForkedHistory(store);
    await store.records(`vendo:app-pin-intents:${appId}`).put({
      id: "pinint_legacy",
      data: {
        slot: SLOT,
        at: "2026-07-15T12:00:00.000Z",
        intent: "Show it in blue",
        versionId: "ver_legacy",
        seq: 99,
      },
      refs: { slot: SLOT },
    });
    const runtime = rebasedRuntime(store);
    const before = await runtime.get(appId, ctx);

    await expect(runtime.pins.rebase({ appId, slot: SLOT }, ctx)).rejects.toMatchObject({
      code: "conflict",
      detail: { reason: "unreplayable-trail" },
    });
    await expect(runtime.get(appId, ctx)).resolves.toEqual(before);
  });

  it("rejects a rebase for unknown pins, missing baselines, undrifted pins, and empty trails", async () => {
    const store = memoryStore();
    const appId = await seedForkedHistory(store);

    const drifted = rebasedRuntime(store);
    await expect(drifted.pins.rebase({ appId, slot: "unknown-slot" }, ctx)).rejects.toMatchObject({
      code: "not-found",
    });

    const withoutBaseline = runtimeOn(store);
    await expect(withoutBaseline.pins.rebase({ appId, slot: SLOT }, ctx)).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("no captured baseline"),
    });

    const undrifted = runtimeOn(store, { captured: OLD_BASELINE() });
    await expect(undrifted.pins.rebase({ appId, slot: SLOT }, ctx)).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("not drifted"),
    });

    // An app fork copies the pin but starts an empty history: the trail cannot
    // vouch for the fork's content, so the rebase refuses instead of silently
    // resetting the remix to the new baseline.
    const copy = await drifted.fork(appId, ctx);
    await expect(drifted.pins.rebase({ appId: copy.id, slot: SLOT }, ctx)).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("no recorded edit trail"),
    });
  });

  it("requires a model, ownership, and audits the rebase as a lifecycle event", async () => {
    const store = memoryStore();
    const appId = await seedForkedHistory(store);
    const modelless = createApps({
      store,
      guard: guardFixture(),
      tools,
      catalog: [],
      pinBaselines: [baseline(NEW_SOURCE, "sha256:maple-new")],
    });
    await expect(modelless.pins.rebase({ appId, slot: SLOT }, ctx)).rejects.toMatchObject({
      code: "not-implemented",
    });

    const guard = guardFixture();
    const runtime = runtimeOn(store, { captured: NEW_BASELINE(), guard });
    const stranger: RunContext = { ...ctx, principal: { kind: "user", subject: "user_stranger" } };
    await expect(runtime.pins.rebase({ appId, slot: SLOT }, stranger)).rejects.toMatchObject({
      code: "not-found",
    });
    await expect(runtime.pins.drift(appId, stranger)).rejects.toMatchObject({ code: "not-found" });

    const result = await runtime.pins.rebase({ appId, slot: SLOT }, ctx);
    expect(result.status).toBe("rebased");
    expect(guard.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "app-lifecycle",
        appId,
        detail: expect.objectContaining({
          operation: "pin-rebase",
          slot: SLOT,
          fromBaseHash: "sha256:maple-old",
          toBaseHash: "sha256:maple-new",
          replayedIntents: 1,
        }),
      }),
    ]));
  });
});
