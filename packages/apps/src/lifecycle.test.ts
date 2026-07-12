import type { RunContext, ToolRegistry } from "@vendoai/core";
import { VENDO_APP_FORMAT, VendoError } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createApps } from "./index.js";
import { basicLanguageModel, guardFixture, memoryStore } from "./testing/index.js";

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

const setup = (withModel = true) => {
  const store = memoryStore();
  const guard = guardFixture();
  const runtime = createApps({
    store,
    guard,
    tools,
    catalog: [],
    model: withModel ? basicLanguageModel() : undefined,
  });
  return { store, guard, runtime };
};

describe("apps lifecycle", () => {
  it("round-trips create, get, and newest-first list without leaking across owners", async () => {
    const { runtime } = setup();
    const ada = context("user_ada");
    const grace = context("user_grace");

    const first = await runtime.create({ prompt: "  First app  " }, ada);
    const second = await runtime.create({ prompt: "Second app" }, ada);

    expect(first).toMatchObject({ format: VENDO_APP_FORMAT, name: "First app", ui: "tree" });
    expect(first.id).toMatch(/^app_/);
    expect(first.tree).toMatchObject({
      formatVersion: "vendo-genui/v1",
      root: "root",
      nodes: [{ id: "root", component: "Text" }],
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
    expect(app.name).toHaveLength(60);
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
    expect(await runtime.history(fork.id).list()).toEqual([]);
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

    const history = runtime.history(app.id);
    const entries = await history.list();
    expect(entries).toHaveLength(50);
    expect(entries[0]?.intent).toBe("Edit 51");
    expect(entries.at(-1)?.intent).toBe("Edit 2");

    const restored = await history.undo();
    expect(restored.name).toBe("Edit 50");
    expect(await runtime.get(app.id, ctx)).toEqual(restored);
    expect(await history.list()).toHaveLength(49);
  });

  it("rejects undo on empty history", async () => {
    const { runtime } = setup();
    const app = await runtime.create({ prompt: "No history" }, context("user_ada"));
    await expect(runtime.history(app.id).undo()).rejects.toEqual(
      new VendoError("conflict", "nothing to undo"),
    );
  });

  it("rejects invalid stored documents on reads with the app id in detail", async () => {
    const { runtime, store } = setup();
    const appId = "app_invalid";
    await store.records("vendo_apps").put({
      id: appId,
      data: { format: VENDO_APP_FORMAT, id: appId, name: "", ui: "tree" },
      refs: { subject: "user_ada" },
    });

    await expect(runtime.get(appId, context("user_ada"))).rejects.toMatchObject({
      code: "validation",
      detail: { appId },
    });
  });
});
