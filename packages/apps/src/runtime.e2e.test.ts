import {
  VENDO_APP_FORMAT,
  type AppDocument,
  type RunContext,
  type ToolRegistry,
} from "@vendoai/core";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { createApps } from "./index.js";
import {
  guardFixture,
  memoryStore,
  seedAppRow,
} from "./testing/index.js";

/**
 * E2E of ownership/interchange authority (06-apps §7, 01-core §10), exercised
 * through the public createApps surface. Real neighbors are the in-repo core
 * seam implementations; persisted side effects are asserted through the store
 * seam (vendo_apps rows). The v1 state-singleton and tool-proxy e2e coverage
 * died with the run-token proxy; the v2 equivalents are the wire /box rows and
 * tools callback suites.
 */

const ctx = (subject: string, presence: RunContext["presence"] = "present"): RunContext => ({
  principal: { kind: "user", subject },
  venue: "app",
  presence,
  sessionId: `session_${subject}`,
});

const encoder = new TextEncoder();

const treeApp = (id: string, name: string): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id,
  name,
  ui: "tree",
  tree: {
    formatVersion: "vendo-genui/v2",
    root: "root",
    nodes: [{ id: "root", component: "Text", source: "prewired", props: { text: name } }],
  },
});

const inertTools: ToolRegistry = {
  async descriptors() { return []; },
  async execute() { return { status: "error", error: { code: "not-found", message: "no tools" } }; },
};

describe("interchange authority (e2e)", () => {
  it("mints a fresh id for a doctored artifact claiming a victim's app id (no takeover)", async () => {
    const store = memoryStore();
    const runtime = createApps({ store, guard: guardFixture(), tools: inertTools, catalog: [] });

    // The victim owns app_victim.
    const victim = treeApp("app_victim", "Victim App");
    await seedAppRow(store, victim, "user_victim", true);

    // An attacker imports an artifact whose embedded id claims the victim's app.
    const doctored = treeApp("app_victim", "Attacker Payload");
    const imported = await runtime.importApp(doctored, ctx("user_attacker"));

    // The claimed id is never trusted: a fresh id is minted and the copy belongs to the attacker.
    expect(imported.id).not.toBe("app_victim");
    expect(imported.id).toMatch(/^app_/);
    expect(imported.name).toBe("Attacker Payload");

    // The victim's row is byte-for-byte intact and still owned by the victim.
    const victimRow = await store.records("vendo_apps").get("app_victim");
    expect((victimRow?.data as { subject: string }).subject).toBe("user_victim");
    expect((victimRow?.data as { doc: AppDocument }).doc).toEqual(victim);
    expect(await runtime.get("app_victim", ctx("user_victim"))).toEqual(victim);

    // The attacker cannot reach the victim's app at all (cross-subject → not found).
    expect(await runtime.get("app_victim", ctx("user_attacker"))).toBeNull();
  });

  it("mints a fresh id for a doctored .vendoapp archive claiming a victim's app id", async () => {
    const store = memoryStore();
    const runtime = createApps({ store, guard: guardFixture(), tools: inertTools, catalog: [] });
    await seedAppRow(store, treeApp("app_target", "Target"), "user_target", true);

    // A hand-built archive whose app.json even carries the victim id inside the document body.
    const archive = zipSync({
      "app.json": encoder.encode(JSON.stringify({ ...treeApp("app_target", "Smuggled"), id: "app_target" })),
    });
    const imported = await runtime.importApp(archive, ctx("user_attacker"));

    expect(imported.id).not.toBe("app_target");
    expect(await runtime.get("app_target", ctx("user_attacker"))).toBeNull();
    expect((await runtime.get("app_target", ctx("user_target")))?.name).toBe("Target");
  });
});

