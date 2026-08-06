import type { AppDocument, RunContext, ToolRegistry } from "@vendoai/core";
import { VENDO_APP_FORMAT, VendoError } from "@vendoai/core";
import type { LanguageModel } from "ai";
import { describe, expect, it, vi } from "vitest";
import { createApps, type SandboxAdapter } from "./index.js";
import { createAppHistory } from "./history.js";
import { enabledAfterDocumentEdit } from "./persistence.js";
import {
  fakeSandbox,
  guardFixture,
  memoryStore,
  seedAppRow,
  scriptedLanguageModel,
  type ScriptedModelCall,
} from "./testing/index.js";

const tools: ToolRegistry = {
  async descriptors() {
    return [];
  },
  async execute() {
    return { status: "error", error: { code: "not-found", message: "No fixture tools" } };
  },
};

const context = (subject: string): RunContext => ({
  principal: { kind: "user", subject },
  venue: "app",
  presence: "present",
  sessionId: `session_${subject}`,
});

const promptText = (call: ScriptedModelCall): string => call.prompt.map((message) => (
  typeof message.content === "string" ? message.content : message.content.map((part) => part.text ?? "").join("")
)).join("\n");

/** What the person just said, as the brain hears it. Capped at the create
 *  validator's display-title length, so the derived app name is legal. */
const lastSaid = (prompt: string): string => {
  const marker = "THEY ARE ASKING NOW: ";
  const at = prompt.lastIndexOf(marker);
  if (at === -1) return "Untitled app";
  const said = prompt.slice(at + marker.length).split("\n")[0]?.trim() ?? "";
  return said.slice(0, 40) || "Untitled app";
};

/** The brain, scripted: every ask is tiny, so it writes the whole app on the
 *  spot and names it after what was said — a create and an edit alike (an edit
 *  answered whole is the same pipeline, just the `direct` branch of it). */
const brainModel = (): LanguageModel => scriptedLanguageModel((call) => {
  const said = lastSaid(promptText(call)).replaceAll('"', "'");
  return `<App name="${said}"><Text text="${said}"/><Disclaimer reason="Scripted fixture app."/></App>`;
});

const setup = (withModel = true) => {
  const store = memoryStore();
  const guard = guardFixture();
  const runtime = createApps({
    store,
    guard,
    tools,
    catalog: [],
    model: withModel ? brainModel() : undefined,
  });
  return { store, guard, runtime };
};

describe("apps lifecycle", () => {
  it("disarms changed triggers on edit and undo while preserving unchanged trigger edits", async () => {
    const store = memoryStore();
    const original: AppDocument = {
      format: VENDO_APP_FORMAT,
      id: "app_trigger_arm",
      name: "Trigger arm",
      triggers: [{
        id: "main",
        on: { kind: "host-event", event: "invoice.created" },
        run: { kind: "steps", steps: [{ id: "read", tool: "host_read" }] },
      }],
    };
    const renamed = { ...original, name: "Renamed" };
    const changed: AppDocument = {
      ...renamed,
      triggers: [{
        id: "main",
        on: { kind: "host-event", event: "invoice.updated" },
        run: { kind: "steps", steps: [{ id: "read", tool: "host_read" }] },
      }],
    };

    expect(enabledAfterDocumentEdit(original, renamed, true)).toBe(true);
    expect(enabledAfterDocumentEdit(original, changed, true)).toBe(false);

    const history = createAppHistory(store);
    await history.append(original.id, original, {
      at: "2026-07-12T12:00:00.000Z",
      intent: "Change trigger",
      rung: 1,
    });
    await seedAppRow(store, changed, "user_ada", true);
    await history.surface(original.id).undo();
    expect((await store.records("vendo_apps").get(original.id))?.data).toMatchObject({
      enabled: false,
      doc: { triggers: original.triggers },
    });
  });

  it("round-trips create, get, and newest-first list without leaking across owners", async () => {
    const { runtime } = setup();
    const ada = context("user_ada");
    const grace = context("user_grace");

    const first = await runtime.create({ prompt: "  First app  " }, ada);
    const second = await runtime.create({ prompt: "Second app" }, ada);

    expect(first).toMatchObject({ format: VENDO_APP_FORMAT, name: "First app", ui: "tree" });
    expect(first.id).toMatch(/^app_/);
    expect(first.tree).toMatchObject({
      formatVersion: "vendo-genui/v2",
      root: "root",
      nodes: [
        { id: "root", component: "Stack" },
        { id: "text-1", component: "Text" },
        { id: "disclaimer-1", component: "Disclaimer" },
      ],
    });
    expect(await runtime.get(first.id, ada)).toEqual(first);
    expect((await runtime.list(ada)).map((app) => app.id)).toEqual([second.id, first.id]);
    expect(await runtime.get(first.id, grace)).toBeNull();
    expect(await runtime.list(grace)).toEqual([]);
    await expect(runtime.delete(first.id, grace)).rejects.toMatchObject({ code: "not-found" });
    await expect(runtime.fork(first.id, grace)).rejects.toMatchObject({ code: "not-found" });
  });

  it("requires a model for generation and constrains generated names", async () => {
    const withoutModel = setup(false).runtime;
    await expect(withoutModel.create({ prompt: "Unavailable" }, context("user_ada"))).rejects.toEqual(
      new VendoError("not-implemented", "generation requires a model"),
    );

    const { runtime } = setup();
    const app = await runtime.create({ prompt: `  ${"x".repeat(80)}  ` }, context("user_ada"));
    // Empty-states batch — the name is a display title capped by the create
    // validator (APP_NAME_MAX_CHARS), never the ask echoed back at length.
    expect(app.name).toHaveLength(40);
  });

  it("forks a fresh validated document without copying history or app data", async () => {
    const { runtime, store } = setup();
    const ctx = context("user_ada");
    const source = await runtime.create({ prompt: "Source" }, ctx);
    await store.records(`app:${source.id}:notes`).put({ id: "note_1", data: { body: "private" } });
    await store.records("vendo_state").put({
      id: `${source.id}:${ctx.principal.subject}`,
      data: { selected: "note_1" },
      refs: { subject: ctx.principal.subject, app_id: source.id },
    });
    await store.blobs(`app:${source.id}:files`).put("secret.txt", new TextEncoder().encode("private"));

    const fork = await runtime.fork(source.id, ctx);

    expect(fork.id).not.toBe(source.id);
    expect(fork).toEqual({ ...source, id: fork.id, forkedFrom: source.id });
    expect(await store.records(`app:${fork.id}:notes`).list()).toEqual({ records: [] });
    expect(await store.records("vendo_state").get(`${fork.id}:${ctx.principal.subject}`)).toBeNull();
    expect(await store.blobs(`app:${fork.id}:files`).list()).toEqual([]);
    expect(await runtime.history(fork.id, ctx).list()).toEqual([]);
  });

  it("a fork never carries a machine or a retired v1 server ref", async () => {
    const store = memoryStore();
    const runtime = createApps({ store, guard: guardFixture(), tools, catalog: [] });
    // A persisted pre-v2 document may still carry a retired v1 server ref.
    const source: AppDocument = {
      format: VENDO_APP_FORMAT,
      id: "app_server_source",
      name: "Server source",
      server: "fake:snap_legacy",
    };
    await seedAppRow(store, source, "user_ada");

    const fork = await runtime.fork(source.id, context("user_ada"));

    expect(fork).not.toHaveProperty("server");
    expect(fork).not.toHaveProperty("machine");
    expect(fork.forkedFrom).toBe(source.id);
  });

  it("emits one scoped lifecycle audit event for each lifecycle mutation", async () => {
    const { runtime, guard } = setup();
    const ctx = { ...context("user_ada"), venue: "chat" as const, presence: "away" as const };

    const app = await runtime.create({ prompt: "Audited" }, ctx);
    const fork = await runtime.fork(app.id, ctx);
    await runtime.delete(fork.id, ctx);

    expect(guard.audit.map((event) => ({
      kind: event.kind,
      principal: event.principal,
      venue: event.venue,
      presence: event.presence,
      appId: event.appId,
      detail: event.detail,
    }))).toEqual([
      {
        kind: "app-lifecycle",
        principal: ctx.principal,
        venue: "chat",
        presence: "away",
        appId: app.id,
        detail: { operation: "create" },
      },
      {
        kind: "app-lifecycle",
        principal: ctx.principal,
        venue: "chat",
        presence: "away",
        appId: fork.id,
        detail: { operation: "fork", sourceAppId: app.id },
      },
      {
        kind: "app-lifecycle",
        principal: ctx.principal,
        venue: "chat",
        presence: "away",
        appId: fork.id,
        detail: { operation: "delete" },
      },
    ]);
  });

  it("caps public history at 50 entries and undo restores and pops the latest snapshot", async () => {
    const { runtime } = setup();
    const ctx = context("user_ada");
    const app = await runtime.create({ prompt: "Original" }, ctx);

    for (let index = 1; index <= 51; index += 1) {
      await runtime.edit(app.id, `Edit ${index}`, ctx);
    }

    const history = runtime.history(app.id, ctx);
    const entries = await history.list();
    expect(entries).toHaveLength(50);
    expect(entries[0]?.intent).toBe("Edit 51");
    expect(entries.at(-1)?.intent).toBe("Edit 2");

    const restored = await history.undo();
    expect(restored.name).toBe("Edit 50");
    expect(await runtime.get(app.id, ctx)).toEqual(restored);
    expect(await history.list()).toHaveLength(49);
  });

  it("keeps the full per-pin replay trail when public version history is capped", async () => {
    const store = memoryStore();
    const history = createAppHistory(store);
    const app: AppDocument = {
      format: VENDO_APP_FORMAT,
      id: "app_pin_intent_history",
      name: "Pinned app",
      pins: [{ slot: "net-worth-card", base: "sha256:base" }],
    };
    await seedAppRow(store, app, "user_ada");
    for (let index = 1; index <= 51; index += 1) {
      await history.append(app.id, app, {
        at: new Date(1_720_000_000_000 + index).toISOString(),
        intent: `Pin edit ${index}`,
        rung: 1,
      }, ["net-worth-card"]);
      // The cap is applied by the caller once its write has LANDED — an append
      // is speculative until then, and pruning inside it charged a refused write
      // the oldest real undo point (see AppHistoryAccess.prune).
      await history.prune(app.id);
    }

    expect(await history.surface(app.id).list()).toHaveLength(50);
    expect((await history.pinIntents(app.id, "net-worth-card")).map(({ intent }) => intent))
      .toEqual(Array.from({ length: 51 }, (_, index) => `Pin edit ${index + 1}`));

    await history.surface(app.id).undo();
    expect(await history.pinIntents(app.id, "net-worth-card")).toHaveLength(50);
  });

  it("undoes same-millisecond edits in strict LIFO order", async () => {
    const store = memoryStore({ timestamp: () => "2026-07-11T12:00:00.000Z" });
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools,
      catalog: [],
      model: brainModel(),
    });
    const app: AppDocument = {
      format: VENDO_APP_FORMAT,
      id: "app_lifo",
      name: "Original",
      ui: "tree",
      tree: {
        formatVersion: "vendo-genui/v2",
        root: "root",
        nodes: [{ id: "root", component: "Text" }],
      },
    };
    await seedAppRow(store, app, "user_ada");
    const uuid = vi.spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValueOnce("ffffffff-ffff-4fff-8fff-ffffffffffff")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000000");
    try {
      await runtime.edit(app.id, "First", context("user_ada"));
      await runtime.edit(app.id, "Second", context("user_ada"));

      await expect(runtime.history(app.id, context("user_ada")).undo()).resolves.toMatchObject({ name: "First" });
      await expect(runtime.history(app.id, context("user_ada")).undo()).resolves.toEqual(app);
    } finally {
      uuid.mockRestore();
    }
  });

  it("rejects undo on empty history", async () => {
    const { runtime } = setup();
    const app = await runtime.create({ prompt: "No history" }, context("user_ada"));
    await expect(runtime.history(app.id, context("user_ada")).undo()).rejects.toEqual(
      new VendoError("conflict", "nothing to undo"),
    );
  });

  it("rejects invalid stored documents on reads with the app id in detail", async () => {
    const { runtime, store } = setup();
    const appId = "app_invalid";
    await store.records("vendo_apps").put({
      id: appId,
      data: {
        subject: "user_ada",
        enabled: false,
        doc: { format: VENDO_APP_FORMAT, id: appId, name: "", ui: "tree" },
      },
      refs: { subject: "user_ada" },
    });

    await expect(runtime.get(appId, context("user_ada"))).rejects.toMatchObject({
      code: "validation",
      detail: { appId },
    });
  });

  it("skips corrupt app and history rows in list surfaces", async () => {
    const { runtime, store } = setup();
    const ctx = context("user_ada");
    const valid = await runtime.create({ prompt: "Valid" }, ctx);
    const edited = await runtime.edit(valid.id, "Edited", ctx);
    await store.records("vendo_apps").put({
      id: "app_corrupt",
      data: {
        subject: ctx.principal.subject,
        enabled: false,
        doc: { format: VENDO_APP_FORMAT, id: "app_corrupt", name: "" },
      },
      refs: { subject: ctx.principal.subject },
    });
    await store.records(`vendo:app-history:${valid.id}`).put({
      id: "ver_corrupt",
      data: { entry: { at: "not-a-date", intent: "bad", rung: 1 }, doc: null },
    });

    await expect(runtime.list(ctx)).resolves.toEqual([edited.app]);
    await expect(runtime.history(valid.id, ctx).list()).resolves.toEqual([edited.version]);
  });
});
