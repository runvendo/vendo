import { VENDO_APP_FORMAT, type RunContext, type ToolRegistry } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createApps } from "./index.js";
import { fakeSandbox, guardFixture, memoryStore } from "./testing/index.js";

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_call" },
  venue: "app",
  presence: "present",
  sessionId: "session_call",
};

const tools: ToolRegistry = {
  async descriptors() { return []; },
  async execute() { return { status: "error", error: { code: "not-found", message: "missing" } }; },
};

describe("machine calls through createApps", () => {
  it("preserves a non-2xx machine error envelope for an unknown fn", async () => {
    const sandbox = fakeSandbox({
      app: () => ({
        status: 404,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: { code: "unknown-function", message: "No such function" } }),
      }),
    });
    const seed = await sandbox.create({ env: {} });
    const server = await seed.snapshot();
    const store = memoryStore();
    await store.records("vendo_apps").put({
      id: "app_call",
      data: { format: VENDO_APP_FORMAT, id: "app_call", name: "Call app", server },
      refs: { subject: ctx.principal.subject },
    });
    const runtime = createApps({ store, guard: guardFixture(), tools, sandbox, catalog: [] });

    await expect(runtime.call("app_call", "fn:missing", {}, ctx)).resolves.toEqual({
      status: "error",
      error: { code: "unknown-function", message: "No such function" },
    });
  });
});
