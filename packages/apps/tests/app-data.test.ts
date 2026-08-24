import { engineOverAdapter } from "@vendoai/core";
import {
  type RunContext,
  type ToolRegistry,
  VENDO_APP_FORMAT,
} from "@vendoai/core";
import type {
  AppDocument,
} from "../src/contract/index.js";
import {
  validateAppDocument,
} from "../src/contract/index.js";
import { describe, expect, it } from "vitest";
import {
  APP_BLOB_MAX_BYTES,
  APP_RECORD_MAX_BYTES,
  createAppData,
} from "../src/server/persistence/app-data.js";
import { createApps, type AppsRuntime } from "../src/server/index.js";
import { scriptedAssembler } from "../src/server/testing/screen-assembler.js";
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

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_ada" },
  venue: "app",
  presence: "present",
  sessionId: "session_ada",
};

const model = basicLanguageModel();

/** The app under test is landed by the ONE engine — the assembler in the `screen`
 *  slot — through the real `authoredScreen` write path, so the storage declarations
 *  these cases hang off a real row rather than a hand-built document. The screen is
 *  named after whatever was asked, so an edit is a rename and lands a version. */
const appsWith = (store: ReturnType<typeof memoryStore>): AppsRuntime => {
  let runtime: AppsRuntime;
  runtime = createApps({
    store,
    guard: guardFixture(),
    tools,
    catalog: [],
    model,
    screen: scriptedAssembler(() => runtime, ({ request }) => {
      // An EDIT's brief leads with the app's memory block, so the ask is its last line.
      const line = request.split("\n").map((part) => part.trim()).filter((part) => part !== "").at(-1) ?? "";
      const words = line.replace(/[^A-Za-z0-9]+/gu, " ").trim().split(" ");
      const name = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join("") || "Untitled";
      return `import { Stack, Text } from "@vendo/screen";

export default function ${name}() {
  return (
    <Stack gap={12}>
      <Text text="Ready" variant="heading" />
    </Stack>
  );
}
`;
    }),
  });
  return runtime;
};

describe("app data persistence", () => {
  it("gates record and file collections on declarations and reserves state", async () => {
    const store = memoryStore();
    const runtime = appsWith(store);
    const created = await runtime.create({ prompt: "Declared storage" }, ctx);
    const app: AppDocument = {
      ...created,
      storage: {
        notes: { about: "Invoice notes" },
        attachments: { about: "Invoice attachments", kind: "files" },
      },
    };
    const data = createAppData({ ops: undefined, store });
    const owner = ctx.principal.subject;

    expect(() => data.records(app, "missing", owner)).toThrow(expect.objectContaining({ code: "not-found" }));
    expect(() => data.blobs(app, "missing", owner)).toThrow(expect.objectContaining({ code: "not-found" }));
    expect(() => data.records(app, "attachments", owner)).toThrow(expect.objectContaining({ code: "not-found" }));
    expect(() => data.blobs(app, "notes", owner)).toThrow(expect.objectContaining({ code: "not-found" }));
    expect(() => data.records(app, "state", owner)).toThrow(expect.objectContaining({ code: "validation" }));
    expect(() => data.blobs(app, "state", owner)).toThrow(expect.objectContaining({ code: "validation" }));
  });

  it("round-trips records with refs filters and validates declared refs", async () => {
    const store = memoryStore();
    const runtime = appsWith(store);
    const created = await runtime.create({ prompt: "Referenced records" }, ctx);
    const app: AppDocument = {
      ...created,
      storage: {
        notes: { about: "Invoice notes", refs: { invoice_id: "host.invoice" } },
      },
    };
    const records = createAppData({ ops: undefined, store }).records(app, "notes", ctx.principal.subject);

    await records.put({ id: "note_1", data: { body: "first" }, refs: { invoice_id: "inv_1" } });
    await records.put({ id: "note_2", data: { body: "second" }, refs: { invoice_id: "inv_2" } });

    await expect(records.list({ refs: { invoice_id: "inv_1" } })).resolves.toMatchObject({
      records: [{ id: "note_1", data: { body: "first" }, refs: { invoice_id: "inv_1" } }],
    });
    await expect(records.put({
      id: "bad_key",
      data: {},
      refs: { customer_id: "cus_1" },
    })).rejects.toMatchObject({ code: "validation" });
    await expect(records.put({
      id: "bad_value",
      data: {},
      refs: { invoice_id: "" },
    })).rejects.toMatchObject({ code: "validation" });
  });

  it("enforces the 256 KB record cap and documented 5 MB blob cap", async () => {
    const store = memoryStore();
    const runtime = appsWith(store);
    const created = await runtime.create({ prompt: "Bounded storage" }, ctx);
    const app: AppDocument = {
      ...created,
      storage: {
        notes: { about: "Bounded notes" },
        attachments: { about: "Bounded attachments", kind: "files" },
      },
    };
    const data = createAppData({ ops: undefined, store });

    await expect(data.records(app, "notes", ctx.principal.subject).put({
      id: "oversized",
      data: { body: "x".repeat(APP_RECORD_MAX_BYTES) },
    })).rejects.toMatchObject({ code: "validation" });
    await expect(data.blobs(app, "attachments", ctx.principal.subject).put(
      "oversized.bin",
      new Uint8Array(APP_BLOB_MAX_BYTES + 1),
    )).rejects.toMatchObject({ code: "validation" });
    await expect(store.records(`app:${app.id}:notes`).get("oversized")).resolves.toBeNull();
    await expect(store.blobs(`app:${app.id}:attachments`).get("oversized.bin")).resolves.toBeNull();
  });

  it("deletes declared records, state, file collections, and the app blob namespace", async () => {
    const store = memoryStore();
    const runtime = appsWith(store);
    const created = await runtime.create({ prompt: "Data owner" }, ctx);
    const withStorage: AppDocument = {
      ...created,
      storage: {
        notes: { about: "Notes about the app" },
        files: { about: "Files attached to the app", kind: "files" },
      },
    };
    await seedAppRow(engineOverAdapter(store), withStorage, ctx.principal.subject);
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
    const runtime = appsWith(store);
    const created = await runtime.create({ prompt: "Renamed storage" }, ctx);
    const oldVersion: AppDocument = {
      ...created,
      storage: { old_notes: { about: "Old notes" } },
    };
    await seedAppRow(engineOverAdapter(store), oldVersion, ctx.principal.subject);
    await runtime.edit(created.id, "Record the old storage version", ctx);
    const current: AppDocument = {
      ...(await runtime.get(created.id, ctx))!,
      storage: { new_notes: { about: "New notes" } },
    };
    await seedAppRow(engineOverAdapter(store), current, ctx.principal.subject);
    await store.records(`app:${created.id}:old_notes`).put({ id: "old_1", data: { body: "old" } });
    await store.records(`app:${created.id}:new_notes`).put({ id: "new_1", data: { body: "new" } });

    await runtime.delete(created.id, ctx);

    expect(await store.records(`app:${created.id}:old_notes`).list()).toEqual({ records: [] });
    expect(await store.records(`app:${created.id}:new_notes`).list()).toEqual({ records: [] });
  });

  it("round-trips the illustrative spec document after correcting its tree shape", async () => {
    const store = memoryStore();
    const runtime = appsWith(store);
    const app: AppDocument = {
      format: VENDO_APP_FORMAT,
      id: "app_7f3k",
      name: "Invoice Chaser",
      description: "Chases overdue invoices every Monday",
      ui: "tree",
      components: {
        SpendChart: "export default function SpendChart() { return null; }",
      },
      storage: {
        notes: { about: "comments pinned to invoices", refs: { invoice_id: "host.invoice" } },
      },
      // The format spec's {schedule: "mon 9:00"} is illustrative: what an app
      // carries is a LIST OF IDS naming automations that are records of their own.
      automations: ["atm_7f3kchase"],
      egress: ["api.stripe.com"],
      secrets: ["STRIPE_KEY"],
      seed: { component: "invoice-card", baseline: "sha256:ab12", wishes: ["make it mine"] },
      forkedFrom: "app_2c9d",
    };

    expect(validateAppDocument(app)).toEqual({ ok: true, app });
    await seedAppRow(engineOverAdapter(store), app, ctx.principal.subject);
    expect(await runtime.get(app.id, ctx)).toEqual(app);
  });
});
