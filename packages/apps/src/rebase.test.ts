import type { AppDocument, RunContext, StoreAdapter, ToolRegistry } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createApps, type AppsRuntime, type PinBaseline } from "./index.js";
import { pinComponentName } from "./pins.js";
import { appVersionHash } from "./version-hash.js";
import {
  guardFixture,
  memoryStore,
  seedAppRow,
  scriptedLanguageModel,
  type ScriptedModelCall,
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
    formatVersion: "vendo-genui/v1",
    root: "root",
    nodes: [{ id: "root", component: "Stack", source: "prewired" }],
  },
});

const promptText = (call: ScriptedModelCall): string => call.prompt.map((message) => {
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => part.text ?? "").join("");
}).join("\n");

const forkOps = JSON.stringify({
  ops: [{ op: "fork-pin", slot: SLOT, nodeId: "worth", parentId: "root" }],
});

/** Fork the pin and record one pinned edit + one non-pin edit on the OLD baseline. */
const seedForkedHistory = async (
  store: StoreAdapter,
  extraPinnedEdits: string[] = [],
): Promise<string> => {
  const app = seedDoc();
  await seedAppRow(store, app, ctx.principal.subject);
  const responses = [
    forkOps,
    JSON.stringify({ ops: [{ op: "add-component", name: COMPONENT, source: OLD_SOURCE.replace("$1.2M", "$1.2M in green") }] }),
    ...extraPinnedEdits.map((marker) => JSON.stringify({
      ops: [{ op: "add-component", name: COMPONENT, source: OLD_SOURCE.replace("$1.2M", marker) }],
    })),
    JSON.stringify({ ops: [{ op: "set-name", name: "Maple overview (renamed)" }] }),
  ];
  const runtime = createApps({
    store,
    guard: guardFixture(),
    tools,
    catalog: [],
    model: scriptedLanguageModel(...responses),
    pinBaselines: [baseline(OLD_SOURCE, "sha256:maple-old")],
  });
  const forked = await runtime.edit(app.id, "Remix the net worth card", ctx);
  expect(forked.failure).toBeUndefined();
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

/** The same store, reopened after the host changed the component and resynced. */
const rebasedRuntime = (
  store: StoreAdapter,
  responses: Parameters<typeof scriptedLanguageModel>,
): AppsRuntime => createApps({
  store,
  guard: guardFixture(),
  tools,
  catalog: [],
  model: scriptedLanguageModel(...responses),
  pinBaselines: [baseline(NEW_SOURCE, "sha256:maple-new")],
});

describe("06-apps §8 — drift surfacing", () => {
  it("reports drift on pins.drift, open() payloads, and edit results after a host resync", async () => {
    const store = memoryStore();
    const appId = await seedForkedHistory(store);
    const runtime = rebasedRuntime(store, [
      JSON.stringify({ ops: [{ op: "set-name", name: "Edited while drifted" }] }),
    ]);

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
    (forged.tree as { nodes: unknown[] }).nodes = [
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
    const prompts: string[] = [];
    const runtime = rebasedRuntime(store, [
      (call) => {
        prompts.push(promptText(call));
        return JSON.stringify({ ops: [{ op: "add-component", name: COMPONENT, source: REPLAYED_SOURCE }] });
      },
      (call) => {
        prompts.push(promptText(call));
        return JSON.stringify({ ops: [{ op: "add-component", name: COMPONENT, source: REPLAYED_SOURCE.replace("in green", "underlined") }] });
      },
    ]);
    const before = await runtime.get(appId, ctx);
    const versionsBefore = await runtime.history(appId).list();

    const result = await runtime.pins.rebase({ appId, slot: SLOT }, ctx);

    if (result.status !== "rebased") throw new Error(`expected rebased, got ${JSON.stringify(result)}`);
    expect(result.slot).toBe(SLOT);
    expect(result.baseHash).toBe("sha256:maple-new");
    expect(result.replayed).toEqual(["Show it in green", "Pinned edit 1: $1.2M underlined"]);
    expect(result.app.pins).toEqual([{ slot: SLOT, base: "sha256:maple-new" }]);
    expect(result.app.components?.[COMPONENT]).toBe(REPLAYED_SOURCE.replace("in green", "underlined"));
    // The fork intent is never replayed (the re-fork is mechanical), non-pin
    // intents are never replayed, and each replay sees the working document
    // carrying the NEW baseline source under the pinned component.
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("INSTRUCTION: Show it in green");
    expect(prompts[0]).toContain("<article><span>Net worth</span>");
    expect(prompts[1]).toContain("INSTRUCTION: Pinned edit 1");
    expect(prompts[1]).toContain("$1.2M in green");
    expect(prompts.join("\n")).not.toContain("Rename the app");
    expect(prompts.join("\n")).not.toContain("Remix the net worth card");

    // The rebase persisted a NEW version: content hash moved, drift cleared.
    expect(appVersionHash(result.app)).not.toBe(appVersionHash(before!));
    await expect(runtime.get(appId, ctx)).resolves.toEqual(result.app);
    await expect(runtime.pins.drift(appId, ctx)).resolves.toEqual([]);
    const versions = await runtime.history(appId).list();
    expect(versions).toHaveLength(versionsBefore.length + 1);
    expect(versions[0]).toEqual(result.version);
    expect(result.version.intent).toContain(`Rebase remixed ${SLOT}`);

    // The trail is untouched: the rebase records no intent of its own, so a
    // future rebase replays exactly the same user intents again.
    const trail = await store.records(`vendo:app-pin-intents:${appId}`).list();
    expect(trail.records.map((record) => (record.data as { intent: string }).intent).sort()).toEqual([
      "Pinned edit 1: $1.2M underlined",
      "Remix the net worth card",
      "Show it in green",
    ]);
  });

  it("mechanically re-forks when the trail holds only the fork intent (nothing to replay)", async () => {
    const store = memoryStore();
    const app = seedDoc("app_fork_only");
    await seedAppRow(store, app, ctx.principal.subject);
    const original = createApps({
      store,
      guard: guardFixture(),
      tools,
      catalog: [],
      model: scriptedLanguageModel(
        forkOps,
        JSON.stringify({ ops: [{ op: "set-name", name: "Renamed, no pinned edits" }] }),
      ),
      pinBaselines: [baseline(OLD_SOURCE, "sha256:maple-old")],
    });
    expect((await original.edit(app.id, "Remix the net worth card", ctx)).failure).toBeUndefined();
    expect((await original.edit(app.id, "Rename the app", ctx)).failure).toBeUndefined();

    const runtime = rebasedRuntime(store, [forkOps]);
    const result = await runtime.pins.rebase({ appId: app.id, slot: SLOT }, ctx);

    // The fork was a verbatim copy of the old baseline with nothing replayable
    // on top, so the rebase is the mechanical re-fork alone: the pin now
    // carries the NEW baseline source verbatim, with no model involvement.
    if (result.status !== "rebased") throw new Error("expected a rebased result");
    expect(result.replayed).toEqual([]);
    expect(result.app.pins).toEqual([{ slot: SLOT, base: "sha256:maple-new" }]);
    expect(result.app.components?.[COMPONENT]).toBe(NEW_SOURCE);
    expect(result.app.name).toBe("Renamed, no pinned edits");
    await expect(runtime.pins.drift(app.id, ctx)).resolves.toEqual([]);
  });

  it("re-forks a host update that switched to a named export with a synthesized default export (ENG-348)", async () => {
    const store = memoryStore();
    const app = seedDoc("app_named_rebase");
    await seedAppRow(store, app, ctx.principal.subject);
    const original = createApps({
      store,
      guard: guardFixture(),
      tools,
      catalog: [],
      model: scriptedLanguageModel(forkOps),
      pinBaselines: [baseline(OLD_SOURCE, "sha256:maple-old")],
    });
    expect((await original.edit(app.id, "Remix the net worth card", ctx)).failure).toBeUndefined();

    const namedSource = NEW_SOURCE.replace("export default function", "export function");
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools,
      catalog: [],
      model: scriptedLanguageModel(forkOps),
      pinBaselines: [baseline(namedSource, "sha256:maple-named")],
    });
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
    const app = seedDoc("app_unexported_rebase");
    await seedAppRow(store, app, ctx.principal.subject);
    const original = createApps({
      store,
      guard: guardFixture(),
      tools,
      catalog: [],
      model: scriptedLanguageModel(forkOps),
      pinBaselines: [baseline(OLD_SOURCE, "sha256:maple-old")],
    });
    expect((await original.edit(app.id, "Remix the net worth card", ctx)).failure).toBeUndefined();

    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools,
      catalog: [],
      model: scriptedLanguageModel(forkOps),
      pinBaselines: [baseline("const NetWorthCard = () => null;", "sha256:maple-unexported")],
    });
    await expect(runtime.pins.rebase({ appId: app.id, slot: SLOT }, ctx)).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("no default export"),
    });
  });

  it("drops an in-client approval by construction: the rebased version needs re-approval", async () => {
    const store = memoryStore();
    const appId = await seedForkedHistory(store);
    const runtime = rebasedRuntime(store, [
      JSON.stringify({ ops: [{ op: "add-component", name: COMPONENT, source: REPLAYED_SOURCE }] }),
    ]);
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

  it("undo restores the pre-rebase version and keeps the replay trail intact", async () => {
    const store = memoryStore();
    const appId = await seedForkedHistory(store);
    const runtime = rebasedRuntime(store, [
      JSON.stringify({ ops: [{ op: "add-component", name: COMPONENT, source: REPLAYED_SOURCE }] }),
    ]);
    const before = await runtime.get(appId, ctx);
    const result = await runtime.pins.rebase({ appId, slot: SLOT }, ctx);
    expect(result.status).toBe("rebased");

    await expect(runtime.history(appId).undo()).resolves.toEqual(before);
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
    const broken = JSON.stringify({ ops: [{ op: "set-prop", nodeId: "missing", prop: "x", value: 1 }] });
    const runtime = rebasedRuntime(store, [
      JSON.stringify({ ops: [{ op: "add-component", name: COMPONENT, source: REPLAYED_SOURCE }] }),
      broken,
      broken,
    ]);
    const before = await runtime.get(appId, ctx);
    const versionsBefore = await runtime.history(appId).list();

    const result = await runtime.pins.rebase({ appId, slot: SLOT }, ctx);

    if (result.status !== "failed") throw new Error("expected a failed rebase");
    expect(result.replayed).toEqual(["Show it in green"]);
    expect(result.failed.intent).toBe("Pinned edit 1: $1.2M underlined");
    expect(result.failed.issues).toEqual(expect.arrayContaining([expect.stringContaining("missing")]));
    expect(result.remaining).toEqual([]);
    // Nothing was persisted: same document, same history, still drifted.
    await expect(runtime.get(appId, ctx)).resolves.toEqual(before);
    await expect(runtime.history(appId).list()).resolves.toEqual(versionsBefore);
    await expect(runtime.pins.drift(appId, ctx)).resolves.toMatchObject([{ slot: SLOT }]);
  });

  it("fails closed when a trail intent routes to the server code dialect instead of a tree edit", async () => {
    const store = memoryStore();
    const appId = await seedForkedHistory(store);
    // A recorded intent only ever comes from a tree edit that touched the pin,
    // so a server-classified instruction in the trail means the trail was
    // tampered with (it is an internal store collection) — never half-apply it.
    await store.records(`vendo:app-pin-intents:${appId}`).put({
      id: "pinint_tampered",
      data: {
        slot: SLOT,
        at: "2026-07-15T12:00:00.000Z",
        intent: "Persist the card to the database",
        versionId: "ver_tampered",
        seq: 99,
      },
      refs: { slot: SLOT },
    });
    const runtime = rebasedRuntime(store, [
      JSON.stringify({ ops: [{ op: "add-component", name: COMPONENT, source: REPLAYED_SOURCE }] }),
      JSON.stringify({ rung: 2, files: [{ path: "/app/index.js", content: "export {}" }] }),
    ]);
    const before = await runtime.get(appId, ctx);

    const result = await runtime.pins.rebase({ appId, slot: SLOT }, ctx);

    if (result.status !== "failed") throw new Error("expected a failed rebase");
    expect(result.replayed).toEqual(["Show it in green"]);
    expect(result.failed.intent).toBe("Persist the card to the database");
    expect(result.failed.issues).toEqual([expect.stringContaining("server code edit")]);
    await expect(runtime.get(appId, ctx)).resolves.toEqual(before);
  });

  it("rejects a rebase for unknown pins, missing baselines, undrifted pins, and empty trails", async () => {
    const store = memoryStore();
    const appId = await seedForkedHistory(store);

    const drifted = rebasedRuntime(store, [forkOps]);
    await expect(drifted.pins.rebase({ appId, slot: "unknown-slot" }, ctx)).rejects.toMatchObject({
      code: "not-found",
    });

    const withoutBaseline = createApps({
      store,
      guard: guardFixture(),
      tools,
      catalog: [],
      model: scriptedLanguageModel(forkOps),
    });
    await expect(withoutBaseline.pins.rebase({ appId, slot: SLOT }, ctx)).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("no captured baseline"),
    });

    const undrifted = createApps({
      store,
      guard: guardFixture(),
      tools,
      catalog: [],
      model: scriptedLanguageModel(forkOps),
      pinBaselines: [baseline(OLD_SOURCE, "sha256:maple-old")],
    });
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
    const runtime = createApps({
      store,
      guard,
      tools,
      catalog: [],
      model: scriptedLanguageModel(
        JSON.stringify({ ops: [{ op: "add-component", name: COMPONENT, source: REPLAYED_SOURCE }] }),
      ),
      pinBaselines: [baseline(NEW_SOURCE, "sha256:maple-new")],
    });
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
