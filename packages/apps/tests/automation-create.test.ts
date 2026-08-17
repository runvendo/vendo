/**
 * `schedule` on an app that has no automation.
 *
 * The refusal is the one sentence the calling model recovers from mid-turn, so
 * it has to carry the exact next move rather than dead-ending.
 */
import { engineOverAdapter, VENDO_APP_FORMAT, type RunContext, type ToolRegistry } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createApps } from "../src/server/index.js";
import { guardFixture } from "../src/server/testing/guard-fixture.js";
import { memoryStore } from "../src/server/testing/memory-store.js";
import { seedAppRow } from "../src/server/testing/seed-app-row.js";

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_ada" },
  venue: "chat",
  presence: "present",
  sessionId: "session_ada",
};

const tools: ToolRegistry = {
  async descriptors() {
    return [{
      name: "host_send_email",
      description: "Send an email.",
      inputSchema: { type: "object", properties: { subject: {}, body: {} } },
      risk: "write",
    }];
  },
  async execute() {
    return { status: "ok", output: { sent: true } };
  },
};

describe("schedule on an app with no automation", () => {
  it("names the door back to vendo_make instead of a dead end", async () => {
    // Field (linkwarden 2026-08-08): the refusal is the one sentence the
    // calling model recovers from mid-turn, so it must carry the exact next
    // move — the make door, this app named, schedule and action in one ask.
    const store = memoryStore();
    const runtime = createApps({ store, guard: guardFixture(), tools, catalog: [] });
    await seedAppRow(engineOverAdapter(store), {
      format: VENDO_APP_FORMAT,
      id: "app_view_only",
      name: "Links",
      ui: "tree",
    }, ctx.principal.subject);
    await expect(runtime.schedule("app_view_only", "*/5 * * * *", ctx))
      .rejects.toThrow(/vendo_make/);
  });
});

