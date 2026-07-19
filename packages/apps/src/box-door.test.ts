import { VENDO_APP_FORMAT, VendoError, type AppDocument, type RunContext, type ToolRegistry } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createApps } from "./index.js";
import { basicLanguageModel, fakeSandbox, guardFixture, memoryStore, seedAppRow } from "./testing/index.js";

const model = basicLanguageModel();
const decoder = new TextDecoder();

const ctx = (subject = "user_ada"): RunContext => ({
  principal: { kind: "user", subject },
  venue: "app",
  presence: "present",
  sessionId: `session_${subject}`,
});

const doc: AppDocument = {
  format: VENDO_APP_FORMAT,
  id: "app_box_door",
  name: "Box door app",
};

const emptyTools: ToolRegistry = {
  async descriptors() { return []; },
  async execute() { return { status: "error", error: { code: "not-found", message: "missing" } }; },
};

describe("AppsRuntime.box.request (execution-v2 fn door)", () => {
  it("wakes the app's machine and proxies one request to its $PORT", async () => {
    const store = memoryStore();
    const sandbox = fakeSandbox({
      app: (request) => ({
        status: 201,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ echo: { method: request.method, path: request.path, body: request.body } }),
      }),
    });
    const runtime = createApps({ store, guard: guardFixture(), tools: emptyTools, catalog: [], model, sandbox });
    await seedAppRow(store, doc, "user_ada");

    const response = await runtime.box.request(doc.id, {
      method: "POST",
      path: "/fn/chaseInvoices",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invoice: "inv_1" }),
    }, ctx());

    expect(response.status).toBe(201);
    expect(JSON.parse(decoder.decode(response.body))).toEqual({
      echo: { method: "POST", path: "/fn/chaseInvoices", body: JSON.stringify({ invoice: "inv_1" }) },
    });
  });

  it("is owner-scoped: another subject sees not-found", async () => {
    const store = memoryStore();
    const runtime = createApps({
      store, guard: guardFixture(), tools: emptyTools, catalog: [], model, sandbox: fakeSandbox(),
    });
    await seedAppRow(store, doc, "user_ada");
    await expect(runtime.box.request(doc.id, { method: "POST", path: "/fn/x" }, ctx("user_bob")))
      .rejects.toMatchObject({ code: "not-found" });
  });

  it("fails honestly without a sandbox adapter", async () => {
    const store = memoryStore();
    const runtime = createApps({ store, guard: guardFixture(), tools: emptyTools, catalog: [], model });
    await seedAppRow(store, doc, "user_ada");
    await expect(runtime.box.request(doc.id, { method: "POST", path: "/fn/x" }, ctx()))
      .rejects.toBeInstanceOf(VendoError);
    await expect(runtime.box.request(doc.id, { method: "POST", path: "/fn/x" }, ctx()))
      .rejects.toMatchObject({ code: "sandbox-unavailable" });
  });
});
