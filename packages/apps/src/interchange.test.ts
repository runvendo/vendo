import type { AppDocument, RunContext, ToolRegistry } from "@vendoai/core";
import { VENDO_APP_FORMAT, validateAppDocument } from "@vendoai/core";
import { unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { createApps } from "./index.js";
import {
  fakeSandbox,
  guardFixture,
  memoryStore,
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
    formatVersion: "vendo-genui/v1",
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
  it("round-trips a copy with fresh ownership, empty data, and a rebuilt machine", async () => {
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
    const sandbox = fakeSandbox();
    const runtime = createApps({
      store,
      guard,
      tools,
      sandbox,
      catalog: [],
      model: scriptedLanguageModel(codeEdit),
    });
    const ada = context("user_ada");
    const grace = context("user_grace");
    const importedSource = await runtime.importApp(document({ forkedFrom: "app_template" }), ada);
    guard.grants[0] = { ...guard.grants[0]!, appId: importedSource.id };
    const edited = await runtime.edit(importedSource.id, "Build a server backend", ada);
    expect(edited.issues).toBeUndefined();
    const source = edited.app;
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
    expect(copy.server).toMatch(/^fake:snap_/);
    expect(copy.server).not.toBe(source.server);
    expect(copy.forkedFrom).toBeUndefined();
    expect(copy.storage).toEqual(source.storage);
    expect(await runtime.get(copy.id, grace)).toEqual(copy);
    expect(await runtime.get(copy.id, ada)).toBeNull();
    expect(await runtime.get(source.id, ada)).toEqual(source);
    expect(await store.records(`app:${copy.id}:invoices`).list()).toEqual({ records: [] });
    expect(await store.records("vendo_state").get(`${copy.id}:user_grace`)).toBeNull();
    expect(guard.grants).toHaveLength(1);
    expect(guard.grants.some((grant) => grant.appId === copy.id)).toBe(false);

    const rebuilt = [...sandbox.machines.values()].at(-1)!;
    expect(decoder.decode(await rebuilt.files.read("/app/server.js"))).toBe("export const ready = true;");
    expect(rebuilt.fileContents.has("/app/node_modules/cache/index.js")).toBe(false);
    expect(guard.audit.filter((event) => event.detail?.operation === "export")).toHaveLength(1);
    expect(guard.audit.filter((event) => event.detail?.operation === "import")).toHaveLength(2);
  });

  it("exports only the document and filtered app directory without identity or lineage", async () => {
    const store = memoryStore();
    const sandbox = fakeSandbox();
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools,
      sandbox,
      catalog: [],
      model: scriptedLanguageModel(codeEdit),
    });
    const ctx = context("user_ada");
    const source = await runtime.importApp(document({ forkedFrom: "app_template" }), ctx);
    const edited = await runtime.edit(source.id, "Build a server backend", ctx);

    const archive = unzipSync(await runtime.exportApp(edited.app.id, ctx));
    expect(Object.keys(archive).sort()).toEqual(["app.json", "app/server.js"]);
    const exported = JSON.parse(decoder.decode(archive["app.json"])) as Record<string, unknown>;
    expect(exported).not.toHaveProperty("id");
    expect(exported).not.toHaveProperty("server");
    expect(exported).not.toHaveProperty("forkedFrom");
    expect(exported.storage).toEqual(edited.app.storage);
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

  it("fails rather than stripping fn surfaces when app files cannot be rebuilt", async () => {
    const guard = guardFixture();
    const runtime = createApps({ store: memoryStore(), guard, tools, catalog: [] });
    const artifact = document({
      tree: {
        formatVersion: "vendo-genui/v1",
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
      message: expect.stringContaining("fn: references require an app server"),
    });
  });

  it("imports machine-independent app files without a sandbox and audits containment", async () => {
    const guard = guardFixture();
    const runtime = createApps({ store: memoryStore(), guard, tools, catalog: [] });
    const { id: _id, ...exported } = document();
    const archive = zipSync({
      "app.json": encoder.encode(JSON.stringify(exported)),
      "app/server.js": encoder.encode("export const ready = true;"),
    });

    const imported = await runtime.importApp(archive, context("user_ada"));

    expect(imported.server).toBeUndefined();
    expect(guard.audit.at(-1)?.detail).toMatchObject({
      operation: "import",
      appDirectory: "contained-without-sandbox",
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
