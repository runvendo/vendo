/**
 * The paint seam's compile carries the host's RISK GRADING to the screen.
 *
 * "Destructive actions ask for confirmation" was left to whoever wrote the
 * screen, and a screen that forgot shipped a cancel button that fired on first
 * click. The product already knows which tools mutate — the host grades every
 * descriptor — so the grading rides the compiled tree (`Tree.writeTools`) and the
 * renderer asks on its own (`@vendoai/ui` tree/confirm-action.tsx).
 *
 * This is the producer half of that seam, through the real door: the registry's
 * own descriptors, the runtime's own floor, no stub between them.
 */
import { describe, expect, it } from "vitest";
import type { RunContext, ToolRegistry } from "@vendoai/core";
import { createApps } from "../src/server/index.js";
import { guardFixture } from "../src/server/testing/guard-fixture.js";
import { memoryStore } from "../src/server/testing/memory-store.js";

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_ada" },
  venue: "app",
  presence: "present",
  sessionId: "session_ada",
};

const schema = { type: "object", properties: { id: { type: "string" } }, required: ["id"] };

const tools: ToolRegistry = {
  async descriptors() {
    return [
      { name: "list_transfers", description: "Recent transfers.", inputSchema: { type: "object", properties: {} }, risk: "read" },
      { name: "cancel_transfer", description: "Cancel a pending transfer.", inputSchema: schema, risk: "write" },
      { name: "purge_account", description: "Close an account for good.", inputSchema: schema, risk: "destructive" },
      { name: "unknown_verb", description: "Nobody graded this.", inputSchema: schema, risk: "ungraded" },
    ];
  },
  async execute() {
    return { status: "error" as const, error: { code: "not-found", message: "no tools" } };
  },
};

const WIRE = `<App name="Transfers"><Text text="Pending"/></App>`;

describe("the compiled tree carries the host's mutating tools", () => {
  it("names every tool graded anything but read, and no read tool", async () => {
    const apps = createApps({ store: memoryStore(), guard: guardFixture(), tools, catalog: [] });

    const compiled = await apps.floor(ctx).compile(WIRE);

    expect(compiled.tree.writeTools).toEqual(["cancel_transfer", "purge_account", "unknown_verb"]);
  });
});
