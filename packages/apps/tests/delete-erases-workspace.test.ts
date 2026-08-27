/**
 * The app cascade's LAST mile. `eraseStore().byApp` already destroys an app's
 * workspace rows, its history and its blobs, and is tested against a real
 * database in `@vendoai/store` — what was missing is anyone calling it. That
 * call is what this proves, with its exact target.
 */
import { engineOverAdapter, VENDO_APP_FORMAT, type RunContext, type StoreOps, type ToolRegistry } from "@vendoai/core";
import { describe, expect, it, vi } from "vitest";
import type { AppDocument } from "../src/contract/index.js";
import { createApps } from "../src/server/index.js";
import { guardFixture } from "../src/server/testing/guard-fixture.js";
import { memoryStore } from "../src/server/testing/memory-store.js";
import { seedAppRow } from "../src/server/testing/seed-app-row.js";

const tools: ToolRegistry = {
  async descriptors() { return []; },
  async execute() { return { status: "error", error: { code: "not-found", message: "no fixture tools" } }; },
};

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_delete" },
  venue: "app",
  presence: "present",
  sessionId: "session_delete",
};

const app: AppDocument = {
  format: VENDO_APP_FORMAT,
  id: "app_erase",
  name: "Erase Me",
  description: "An app whose workspace files must go with it",
  ui: "tree",
  components: {},
};

describe("deleting an app", () => {
  it("erases the app's workspace files and blobs through the store's own cascade", async () => {
    const store = memoryStore();
    const erase = vi.fn(async () => ({}));
    const ops = { lifecycle: { erase, promote: async () => {} } } as unknown as StoreOps;
    const runtime = createApps({ store, ops, guard: guardFixture(), tools, catalog: [] });
    await seedAppRow(engineOverAdapter(store), app, ctx.principal.subject);

    await runtime.delete(app.id, ctx);

    expect(erase).toHaveBeenCalledWith({ appId: app.id });
  });
});
