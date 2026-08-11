import { engineOverAdapter } from "@vendoai/core";
import {
  type RunContext,
  type ToolRegistry,
  VENDO_APP_FORMAT,
  VendoError,
} from "@vendoai/core";
import type {
  AppDocument,
  ScreenAssembler,
} from "../src/contract/index.js";
import { describe, expect, it, vi } from "vitest";
import { createApps, type AppsRuntime } from "../src/server/index.js";
import { createAppHistory } from "../src/server/persistence/history.js";
import { enabledAfterDocumentEdit } from "../src/server/persistence/persistence.js";
import { scriptedAssembler } from "../src/server/testing/authoring-assembler.js";
import { guardFixture } from "../src/server/testing/guard-fixture.js";
import { memoryStore } from "../src/server/testing/memory-store.js";
import { basicLanguageModel } from "../src/server/testing/scripted-model.js";
import { seedAppRow } from "../src/server/testing/seed-app-row.js";

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

/** What the person just said, as a legal display title. An EDIT's brief leads
 *  with the app's memory block, so the ask itself is the last line of it. Capped
 *  at the create validator's display-title length (APP_NAME_MAX_CHARS). */
const titleFor = (request: string): string => {
  const said = request.split("\n").map((line) => line.trim()).filter((line) => line !== "").at(-1) ?? "";
  return said.slice(0, 40).replaceAll('"', "'") || "Untitled app";
};

/** The ONE engine, scripted: every ask is tiny, so the assembler writes the whole
 *  app on the spot and names it after what was said — a create and an edit alike.
 *  It lands through the real `AppsRuntime.authored`, so the row, the version, the
 *  audit event and the guard decision are all the shipped ones. */
const screenFor = (runtime: () => AppsRuntime): ScreenAssembler =>
  scriptedAssembler(runtime, ({ request }) => {
    const said = titleFor(request);
    return `<App name="${said}"><Text text="${said}"/><Disclaimer reason="Scripted fixture app."/></App>`;
  });

const setup = (withModel = true) => {
  const store = memoryStore();
  const guard = guardFixture();
  let runtime: AppsRuntime;
  runtime = createApps({
    store,
    guard,
    tools,
    catalog: [],
    model: withModel ? basicLanguageModel() : undefined,
    screen: screenFor(() => runtime),
  });
  return { store, guard, runtime };
};

describe("apps lifecycle", () => {
  it("disarms changed triggers on edit while preserving unchanged trigger edits", async () => {
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
    // Empty-states batch — the name is a display title, never the ask echoed
    // back at length.
    expect(app.name).toHaveLength(40);
    // …and the cap is the PRODUCT's, not the fixture's: the same document with
    // the ask echoed back whole is a finding at the `validate` door, which is
    // where the create validator's APP_NAME_MAX_CHARS now bites.
    const echoed = "x".repeat(80);
    const verdict = await runtime.validate(
      { document: `<App name="${echoed}"><Text text="hi"/><Disclaimer reason="Fixture."/></App>` },
      context("user_ada"),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.findings.some(({ message }) => message.includes("at most 40 characters"))).toBe(true);
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

  it("a fork never carries a machine", async () => {
    const store = memoryStore();
    const runtime = createApps({ store, guard: guardFixture(), tools, catalog: [] });
    const source: AppDocument = {
      format: VENDO_APP_FORMAT,
      id: "app_machine_source",
      name: "Machine source",
      machine: { snapshotRef: "fake:snap_legacy", provisionedAt: "2026-07-19T00:00:00.000Z" },
    };
    await seedAppRow(engineOverAdapter(store), source, "user_ada");

    const fork = await runtime.fork(source.id, context("user_ada"));

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

  it("caps public history at 50 entries", async () => {
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
  });

  it("keeps the full per-pin replay trail when public version history is capped", async () => {
    const store = memoryStore();
    const history = createAppHistory(engineOverAdapter(store));
    const app: AppDocument = {
      format: VENDO_APP_FORMAT,
      id: "app_pin_intent_history",
      name: "Pinned app",
      seed: { component: "net-worth-card", baseline: "sha256:base" },
    };
    await seedAppRow(engineOverAdapter(store), app, "user_ada");
    for (let index = 1; index <= 51; index += 1) {
      await history.append(app.id, app, {
        at: new Date(1_720_000_000_000 + index).toISOString(),
        intent: `Pin edit ${index}`,
        rung: 1,
      });
      // The cap is applied by the caller once its write has LANDED — an append
      // is speculative until then, and pruning inside it charged a refused write
      // the oldest real version (see AppHistoryAccess.prune).
      await history.prune(app.id);
    }

    expect(await history.surface(app.id).list()).toHaveLength(50);
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

  it("reports the version history stored, not a later clock read", async () => {
    // Only `Date` is faked: the store, the guard and every await in the write
    // path still run on real timers.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-12T12:00:00.000Z"));
    try {
      const store = memoryStore();
      let runtime: AppsRuntime;
      const assembler = screenFor(() => runtime);
      runtime = createApps({
        store,
        guard: guardFixture(),
        tools,
        catalog: [],
        model: basicLanguageModel(),
        // The assembler's save is where the history row is appended, so moving
        // the clock the moment it returns puts every later read in the NEXT
        // millisecond — the straddle that used to need a busy machine.
        screen: {
          async assemble(request, assembleCtx) {
            const outcome = await assembler.assemble(request, assembleCtx);
            vi.setSystemTime(new Date(Date.now() + 1));
            return outcome;
          },
        },
      });
      const ctx = context("user_ada");
      const app = await runtime.create({ prompt: "Valid" }, ctx);
      const edited = await runtime.edit(app.id, "Edited", ctx);

      await expect(runtime.history(app.id, ctx).list()).resolves.toEqual([edited.version]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never reports an overlapping edit's version as its own", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-12T12:00:00.000Z"));
    /** A save that has landed, and a hold released by the test. */
    const gate = () => {
      let open = (): void => {};
      const held = new Promise<void>((resolve) => {
        open = resolve;
      });
      let landed = (): void => {};
      const saved = new Promise<void>((resolve) => {
        landed = resolve;
      });
      return { held, open, saved, landed };
    };
    const gates = new Map([["First", gate()], ["Second", gate()]]);
    const gateFor = (request: string) =>
      [...gates].find(([instruction]) => request.trimEnd().endsWith(instruction))?.[1];
    try {
      const store = memoryStore();
      let runtime: AppsRuntime;
      const assembler = screenFor(() => runtime);
      runtime = createApps({
        store,
        guard: guardFixture(),
        tools,
        catalog: [],
        model: basicLanguageModel(),
        // Held between the save and the answer, so the test can interleave two
        // edits of the SAME app around each other's history row.
        screen: {
          async assemble(request, assembleCtx) {
            const outcome = await assembler.assemble(request, assembleCtx);
            vi.setSystemTime(new Date(Date.now() + 1));
            const held = gateFor(request.request);
            if (held !== undefined) {
              held.landed();
              await held.held;
            }
            return outcome;
          },
        },
      });
      const ctx = context("user_ada");
      const app = await runtime.create({ prompt: "Valid" }, ctx);

      // "First" saves its row, then waits. "Second" starts on top of it, saves
      // its own row, and waits too — so when "First" answers, the newest row on
      // this app is SOMEONE ELSE'S edit.
      const first = runtime.edit(app.id, "First", ctx);
      await gates.get("First")?.saved;
      const second = runtime.edit(app.id, "Second", ctx);
      await gates.get("Second")?.saved;
      gates.get("First")?.open();
      const firstResult = await first;
      gates.get("Second")?.open();
      const secondResult = await second;

      // Never the sibling's row — the words in the version an edit reports are
      // the words that edit was given.
      expect(firstResult.version.intent).toBe("First");
      expect(secondResult.version.intent).toBe("Second");
      // …and the edit whose row is still the newest one reports it verbatim.
      await expect(runtime.history(app.id, ctx).list()).resolves.toContainEqual(secondResult.version);
    } finally {
      vi.useRealTimers();
    }
  });
});
