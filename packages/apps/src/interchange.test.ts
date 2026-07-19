import type { AppDocument, RunContext, ToolRegistry } from "@vendoai/core";
import { VENDO_APP_FORMAT, validateAppDocument } from "@vendoai/core";
import { unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { createApps, type SandboxAdapter } from "./index.js";
import {
  fakeSandbox,
  guardFixture,
  memoryStore,
  seedAppRow,
  scriptedLanguageModel,
} from "./testing/index.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const tools: ToolRegistry = {
  async descriptors() { return []; },
  async execute() { return { status: "error", error: { code: "not-found", message: "missing" } }; },
};

const context = (subject: string): RunContext => ({
  principal: { kind: "user", subject },
  venue: "app",
  presence: "present",
  sessionId: `session_${subject}`,
});

const document = (overrides: Partial<AppDocument> = {}): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id: "app_artifact_id_is_untrusted",
  name: "Invoice Chaser",
  ui: "tree",
  tree: {
    formatVersion: "vendo-genui/v2",
    root: "root",
    nodes: [{ id: "root", component: "Text", props: { text: "Invoices" } }],
  },
  storage: { invoices: { about: "Invoices being chased", refs: { invoice: "host.invoice" } } },
  ...overrides,
});

const codeEdit = JSON.stringify({
  rung: 2,
  files: [
    { path: "/app/server.js", content: "export const ready = true;" },
    { path: "/app/node_modules/cache/index.js", content: "export const cache = true;" },
  ],
});

describe(".vendoapp interchange through createApps", () => {
  it("round-trips a copy with fresh ownership and empty data", async () => {
    const store = memoryStore();
    const guard = guardFixture({ grants: [{
      id: "grt_source",
      subject: "user_ada",
      tool: "host_invoices_list",
      descriptorHash: "hash",
      scope: { kind: "tool" },
      duration: "standing",
      appId: "app_will_be_replaced",
      source: "chat",
      grantedAt: "2026-07-11T12:00:00.000Z",
    }] });
    const runtime = createApps({ store, guard, tools, catalog: [] });
    const ada = context("user_ada");
    const grace = context("user_grace");
    const source = await runtime.importApp(document({ forkedFrom: "app_template" }), ada);
    guard.grants[0] = { ...guard.grants[0]!, appId: source.id };
    await store.records(`app:${source.id}:invoices`).put({ id: "invoice_1", data: { total: 42 } });
    await store.records("vendo_state").put({
      id: `${source.id}:user_ada`,
      data: { selected: "invoice_1" },
      refs: { subject: "user_ada", app_id: source.id },
    });

    const bytes = await runtime.exportApp(source.id, ada);
    const copy = await runtime.importApp(bytes, grace);

    expect(copy.id).not.toBe(source.id);
    expect(copy.id).toMatch(/^app_/);
    expect(copy.forkedFrom).toBeUndefined();
    expect(copy.storage).toEqual(source.storage);
    expect(await runtime.get(copy.id, grace)).toEqual(copy);
    expect(await runtime.get(copy.id, ada)).toBeNull();
    expect(await runtime.get(source.id, ada)).toEqual(source);
    expect(await store.records(`app:${copy.id}:invoices`).list()).toEqual({ records: [] });
    expect(await store.records("vendo_state").get(`${copy.id}:user_grace`)).toBeNull();
    expect(guard.grants).toHaveLength(1);
    expect(guard.grants.some((grant) => grant.appId === copy.id)).toBe(false);
    expect(guard.audit.filter((event) => event.detail?.operation === "export")).toHaveLength(1);
    expect(guard.audit.filter((event) => event.detail?.operation === "import")).toHaveLength(2);
  });

  it("exports only the document, without identity, lineage, or machine state", async () => {
    const store = memoryStore();
    const runtime = createApps({ store, guard: guardFixture(), tools, catalog: [] });
    const ctx = context("user_ada");
    // A persisted pre-v2 document may still carry a retired v1 server ref;
    // export is document-only and never writes it (or any app/ directory).
    const legacy = document({ id: "app_legacy", forkedFrom: "app_template", server: "fake:snap_legacy" });
    await seedAppRow(store, legacy, "user_ada");

    const archive = unzipSync(await runtime.exportApp("app_legacy", ctx));
    expect(Object.keys(archive)).toEqual(["app.json"]);
    const exported = JSON.parse(decoder.decode(archive["app.json"])) as Record<string, unknown>;
    expect(exported).not.toHaveProperty("id");
    expect(exported).not.toHaveProperty("server");
    expect(exported).not.toHaveProperty("forkedFrom");
    expect(exported.storage).toEqual(legacy.storage);
  });

  it("drops unknown authority and data fields on both import and export", async () => {
    const store = memoryStore();
    const runtime = createApps({ store, guard: guardFixture(), tools, catalog: [] });
    const ctx = context("user_ada");
    const artifact = {
      ...document(),
      grants: [{ tool: "host_pay" }],
      data: { private: true },
    } as AppDocument & { grants: unknown; data: unknown };

    const imported = await runtime.importApp(artifact, ctx);
    expect(imported).not.toHaveProperty("grants");
    expect(imported).not.toHaveProperty("data");

    await seedAppRow(
      store,
      { ...imported, permissions: ["admin"], caches: { secret: true } } as AppDocument,
      ctx.principal.subject,
    );
    const archive = unzipSync(await runtime.exportApp(imported.id, ctx));
    const exported = JSON.parse(decoder.decode(archive["app.json"])) as Record<string, unknown>;
    expect(exported).not.toHaveProperty("permissions");
    expect(exported).not.toHaveProperty("caches");
  });

  it("fails export for forbidden or missing pin baselines and preserves allowed pins", async () => {
    const ctx = context("user_ada");
    const pin = { slot: "invoice-card", base: "sha256:x" };
    const cases = [
      { baselines: [], allowed: false },
      {
        baselines: [{
          slot: "invoice-card", source: "source", hash: "sha256:x", exportable: false,
          capturedAt: "2026-07-11T12:00:00.000Z",
        }],
        allowed: false,
      },
      {
        baselines: [{
          slot: "invoice-card", source: "source", hash: "sha256:different", exportable: true,
          capturedAt: "2026-07-11T12:00:00.000Z",
        }],
        allowed: false,
      },
      {
        baselines: [{
          slot: "invoice-card", source: "source", hash: "sha256:x", exportable: true,
          capturedAt: "2026-07-11T12:00:00.000Z",
        }],
        allowed: true,
      },
    ];

    for (const testCase of cases) {
      const runtime = createApps({
        store: memoryStore(),
        guard: guardFixture(),
        tools,
        catalog: [],
        pinBaselines: testCase.baselines,
      });
      const app = await runtime.importApp(document({ pins: [pin] }), ctx);
      if (!testCase.allowed) {
        await expect(runtime.exportApp(app.id, ctx)).rejects.toMatchObject({
          code: "blocked",
          message: "pin invoice-card is not exportable",
        });
      } else {
        const archive = unzipSync(await runtime.exportApp(app.id, ctx));
        const exported = JSON.parse(decoder.decode(archive["app.json"])) as AppDocument;
        expect(exported.pins).toEqual([pin]);
      }
    }
  });

  it("imports a valid spec-style document under a fresh id", async () => {
    const runtime = createApps({
      store: memoryStore(), guard: guardFixture(), tools, catalog: [],
    });
    const artifact = document();
    expect(validateAppDocument(artifact).ok).toBe(true);

    const imported = await runtime.importApp(artifact, context("user_ada"));

    expect(imported.id).not.toBe(artifact.id);
    expect(validateAppDocument(imported)).toEqual({ ok: true, app: imported });
  });

  it("classifies malformed archive bytes as validation errors", async () => {
    const runtime = createApps({
      store: memoryStore(), guard: guardFixture(), tools, catalog: [],
    });
    await expect(runtime.importApp(new Uint8Array([1, 2, 3]), context("user_ada"))).rejects.toMatchObject({
      code: "validation",
    });
  });

  it("rejects an archive entry whose inflated bytes exceed the resource cap", async () => {
    const runtime = createApps({
      store: memoryStore(), guard: guardFixture(), tools, catalog: [],
    });
    const { id: _id, ...exported } = document();
    const archive = zipSync({
      "app.json": encoder.encode(JSON.stringify(exported)),
      "app/oversized.bin": new Uint8Array(16 * 1024 * 1024 + 1),
    }, { level: 6 });

    await expect(runtime.importApp(archive, context("user_ada"))).rejects.toMatchObject({
      code: "validation",
      message: "app archive exceeds size limits",
    });
  });

  it("ignores an archived app directory: import is document-only and the copy re-graduates", async () => {
    const guard = guardFixture();
    const runtime = createApps({ store: memoryStore(), guard, tools, catalog: [] });
    const { id: _id, ...exported } = document();
    const archive = zipSync({
      "app.json": encoder.encode(JSON.stringify(exported)),
      "app/server.js": encoder.encode("export const ready = true;"),
    });

    const imported = await runtime.importApp(archive, context("user_ada"));

    expect(imported.server).toBeUndefined();
    expect(imported.machine).toBeUndefined();
    expect(guard.audit.at(-1)?.detail).toMatchObject({
      operation: "import",
      appDirectory: "ignored",
    });
  });

  it("fails rather than stripping fn surfaces when app files cannot be rebuilt", async () => {
    const guard = guardFixture();
    const runtime = createApps({ store: memoryStore(), guard, tools, catalog: [] });
    const artifact = document({
      tree: {
        formatVersion: "vendo-genui/v2",
        root: "root",
        nodes: [{
          id: "root",
          component: "Button",
          props: { onClick: { action: "fn:send_invoice" } },
        }],
      },
      server: "fake:source_snapshot",
    });
    const { id: _id, server: _server, ...exported } = artifact;
    const archive = zipSync({
      "app.json": encoder.encode(JSON.stringify(exported)),
      "app/server.js": encoder.encode("export const ready = true;"),
    });

    await expect(runtime.importApp(archive, context("user_ada"))).rejects.toMatchObject({
      code: "validation",
      message: expect.stringContaining("fn: references require a machine"),
    });
  });

  it("returns not-found for absent or foreign exports", async () => {
    const runtime = createApps({
      store: memoryStore(), guard: guardFixture(), tools, catalog: [],
    });
    await expect(runtime.exportApp("app_missing", context("user_ada"))).rejects.toMatchObject({ code: "not-found" });
    const app = await runtime.importApp(document(), context("user_ada"));
    await expect(runtime.exportApp(app.id, context("user_grace"))).rejects.toMatchObject({ code: "not-found" });
  });
});
