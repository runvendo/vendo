// Gesture-owned forking (2026-07-21) — the fork executes DETERMINISTICALLY
// when the user acts on a remixable slot (pins.fork): the engine copies the
// captured source and records the pin with NO model call. The model lost the
// fork decision entirely; an instruction riding the gesture reaches the model
// already scoped to an ordinary island edit on the existing fork.
import type { AppDocument, RunContext, StoreAdapter, ToolRegistry } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createApps, type AppsConfig, type PinBaseline } from "./index.js";
import { pinComponentName } from "./pins.js";
import {
  guardFixture,
  memoryStore,
  seedAppRow,
  scriptedLanguageModel,
  type ScriptedModelCall,
} from "./testing/index.js";

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

const promptText = (call: ScriptedModelCall): string => call.prompt.map((message) => {
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => part.text ?? "").join("");
}).join("\n");

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
    // The fork is a recorded version: undo returns to the pre-fork app.
    const versions = await runtime.history(app.id).list();
    expect(versions.map(({ intent }) => intent)).toContain(forked.version.intent);
    const undone = await runtime.history(app.id).undo();
    expect(undone.pins ?? []).toEqual([]);
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

  it("runs a gesture instruction as ONE ordinary edit, already scoped to the fork", async () => {
    const store = memoryStore();
    const app = seedDoc();
    await seedAppRow(store, app, ctx.principal.subject);
    const calls: ScriptedModelCall[] = [];
    const runtime = runtimeWith(store, {
      model: scriptedLanguageModel((call) => {
        calls.push(call);
        return `<Edit><Island name="${COMPONENT}">${SOURCE.replace("$1.2M", "$1.2M in blue")}</Island></Edit>`;
      }),
    });

    const forked = await runtime.pins.fork(
      { appId: app.id, slot: SLOT, instruction: "make the number blue" },
      ctx,
    );
    expect(forked.edit?.failure).toBeUndefined();
    expect(forked.app.components?.[COMPONENT]).toContain("$1.2M in blue");
    expect(forked.app.pins).toEqual([{ slot: SLOT, base: "sha256:maple-base" }]);
    // Exactly one model call, and it was scoped: the fork already exists.
    expect(calls.length).toBe(1);
    const prompt = promptText(calls[0]!);
    expect(prompt).toContain(`already forked into the generated component "${COMPONENT}"`);
    expect(prompt).toContain("make the number blue");
    // The dialect no longer teaches the model to fork.
    expect(prompt).not.toContain("<ForkPin");
  });

  it("keeps the faithful fork when the scoped instruction edit fails", async () => {
    const store = memoryStore();
    const app = seedDoc();
    await seedAppRow(store, app, ctx.principal.subject);
    const runtime = runtimeWith(store, {
      model: scriptedLanguageModel("not an edit document", "still not an edit document"),
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
    const forkRuntime = runtimeWith(store, {
      model: scriptedLanguageModel(
        `<Edit><Island name="${COMPONENT}">${SOURCE.replace("$1.2M", "$1.2M in blue")}</Island></Edit>`,
      ),
    });
    const forked = await forkRuntime.pins.fork(
      { appId: app.id, slot: SLOT, instruction: "make the number blue" },
      ctx,
    );
    expect(forked.edit?.failure).toBeUndefined();

    // The host updates the component and resyncs: same store, new baseline.
    const NEW_SOURCE = SOURCE.replace("NetWorthCard()", "NetWorthCard() /* v2 */");
    const replayed: string[] = [];
    const rebaseRuntime = runtimeWith(store, {
      pinBaselines: [{ ...baseline, source: NEW_SOURCE, hash: "sha256:maple-new" }],
      model: scriptedLanguageModel((call) => {
        replayed.push(promptText(call));
        return `<Edit><Island name="${COMPONENT}">${NEW_SOURCE.replace("$1.2M", "$1.2M in blue")}</Island></Edit>`;
      }),
    });
    await expect(rebaseRuntime.pins.drift(app.id, ctx)).resolves.toEqual([
      expect.objectContaining({ slot: SLOT, reason: "baseline-changed" }),
    ]);
    const rebase = await rebaseRuntime.pins.rebase({ appId: app.id, slot: SLOT }, ctx);
    expect(rebase.status).toBe("rebased");
    if (rebase.status !== "rebased") throw new Error("expected rebased");
    // Only the LATER modification replays — the gesture fork itself is
    // mechanical (intents[0] by construction), never re-sent to the model.
    expect(rebase.replayed.length).toBe(1);
    expect(rebase.replayed[0]).toContain("make the number blue");
    expect(rebase.app.pins).toEqual([{ slot: SLOT, base: "sha256:maple-new" }]);
    expect(rebase.app.components?.[COMPONENT]).toContain("$1.2M in blue");
    expect(rebase.app.components?.[COMPONENT]).toContain("/* v2 */");
  });
});
