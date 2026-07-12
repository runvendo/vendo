import type { AppDocument, RunContext, ToolRegistry } from "@vendoai/core";
import { VENDO_APP_FORMAT, validateAppDocument } from "@vendoai/core";
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

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_ada" },
  venue: "app",
  presence: "present",
  sessionId: "session_ada",
};

const model = basicLanguageModel();

describe("app data persistence", () => {
  it("deletes declared records, state, file collections, and the app blob namespace", async () => {
    const store = memoryStore();
    const runtime = createApps({ store, guard: guardFixture(), tools, catalog: [], model });
    const created = await runtime.create({ prompt: "Data owner" }, ctx);
    const withStorage: AppDocument = {
      ...created,
      storage: {
        notes: { about: "Notes about the app" },
        files: { about: "Files attached to the app", kind: "files" },
      },
    };
    await store.records("vendo_apps").put({
      id: created.id,
      data: withStorage,
      refs: { subject: ctx.principal.subject },
    });
    await store.records(`app:${created.id}:notes`).put({ id: "note_1", data: { body: "hello" } });
    await store.records("vendo_state").put({
      id: `${created.id}:${ctx.principal.subject}`,
      data: { tab: "notes" },
      refs: { subject: ctx.principal.subject, app_id: created.id },
    });
    await store.blobs(`app:${created.id}:files`).put("attachment.txt", new TextEncoder().encode("hello"));
    await store.blobs(`app:${created.id}`).put("machine.bin", new Uint8Array([1, 2, 3]));

    await runtime.delete(created.id, ctx);

    expect(await store.records("vendo_apps").get(created.id)).toBeNull();
    expect(await store.records(`app:${created.id}:notes`).list()).toEqual({ records: [] });
    expect(await store.records("vendo_state").get(`${created.id}:${ctx.principal.subject}`)).toBeNull();
    expect(await store.blobs(`app:${created.id}:files`).list()).toEqual([]);
    expect(await store.blobs(`app:${created.id}`).list()).toEqual([]);
  });

  it("deletes collections declared only by a historical app version", async () => {
    const store = memoryStore();
    const runtime = createApps({ store, guard: guardFixture(), tools, catalog: [], model });
    const created = await runtime.create({ prompt: "Renamed storage" }, ctx);
    const oldVersion: AppDocument = {
      ...created,
      storage: { old_notes: { about: "Old notes" } },
    };
    await store.records("vendo_apps").put({
      id: created.id,
      data: oldVersion,
      refs: { subject: ctx.principal.subject },
    });
    await runtime.edit(created.id, "Record the old storage version", ctx);
    const current: AppDocument = {
      ...(await runtime.get(created.id, ctx))!,
      storage: { new_notes: { about: "New notes" } },
    };
    await store.records("vendo_apps").put({
      id: created.id,
      data: current,
      refs: { subject: ctx.principal.subject },
    });
    await store.records(`app:${created.id}:old_notes`).put({ id: "old_1", data: { body: "old" } });
    await store.records(`app:${created.id}:new_notes`).put({ id: "new_1", data: { body: "new" } });

    await runtime.delete(created.id, ctx);

    expect(await store.records(`app:${created.id}:old_notes`).list()).toEqual({ records: [] });
    expect(await store.records(`app:${created.id}:new_notes`).list()).toEqual({ records: [] });
  });

  it("round-trips the illustrative spec document after correcting its tree and trigger shapes", async () => {
    const store = memoryStore();
    const runtime = createApps({ store, guard: guardFixture(), tools, catalog: [], model });
    const app: AppDocument = {
      format: VENDO_APP_FORMAT,
      id: "app_7f3k",
      name: "Invoice Chaser",
      description: "Chases overdue invoices every Monday",
      ui: "tree",
      tree: {
        formatVersion: "vendo-genui/v1",
        root: "root",
        nodes: [{ id: "root", component: "Text", props: { text: "Invoice Chaser" } }],
        data: {},
        queries: [],
      },
      components: {
        SpendChart: "export default function SpendChart() { return null; }",
      },
      storage: {
        notes: { about: "comments pinned to invoices", refs: { invoice_id: "host.invoice" } },
      },
      server: "e2b:snap_x91",
      // The format spec's {schedule: "mon 9:00"} is illustrative; core's {on, run} Trigger wins.
      trigger: {
        on: { kind: "schedule", cron: "0 9 * * 1" },
        run: { kind: "steps", steps: [{ id: "chase", tool: "fn:chase", args: { invoice: "event" } }] },
      },
      egress: ["api.stripe.com"],
      secrets: ["STRIPE_KEY"],
      pins: [{ slot: "invoice-card", base: "sha256:ab12" }],
      forkedFrom: "app_2c9d",
    };

    expect(validateAppDocument(app)).toEqual({ ok: true, app });
    await store.records("vendo_apps").put({
      id: app.id,
      data: app,
      refs: { subject: ctx.principal.subject },
    });
    expect(await runtime.get(app.id, ctx)).toEqual(app);
  });
});
