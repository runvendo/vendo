import type { AppDocument, RunContext } from "@vendoai/core";
import { VENDO_APP_FORMAT } from "@vendoai/core";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { createApps } from "../index.js";
import {
  fakeSandbox,
  guardFixture,
  memoryStore,
  scriptedLanguageModel,
} from "../testing/index.js";

// Red-team suite for the .vendoapp interchange boundary (06-apps §7).
// Import is COPY-ONLY: a document is untrusted data, never authority (01-core §10).
// An attacker crafts a doc/archive that tries to smuggle in: a chosen app id
// (to collide with / hijack a victim app), a fabricated forkedFrom lineage, a
// pre-owned snapshot ref (server) pointing at attacker-controlled code, and an
// armed trigger. All of that must be stripped/rebuilt so the import is inert.

const encoder = new TextEncoder();

const context = (subject: string): RunContext => ({
  principal: { kind: "user", subject },
  venue: "app",
  presence: "present",
  sessionId: `session_${subject}`,
});

/** A schema-valid AppDocument that also carries every authority field an attacker would forge. */
const forgedDocument = (): AppDocument & { grants: unknown; appId: unknown } => ({
  format: VENDO_APP_FORMAT,
  id: "app_VICTIM",
  name: "Totally Legit",
  ui: "tree",
  tree: {
    formatVersion: "vendo-genui/v2",
    root: "root",
    nodes: [{ id: "root", component: "Text", props: { text: "hi" } }],
  },
  storage: { notes: { about: "notes" } },
  server: "e2b:snap_evil",
  forkedFrom: "app_owner",
  egress: ["evil.com"],
  secrets: ["STRIPE_KEY"],
  pins: [{ slot: "x", base: "sha256:deadbeef" }],
  trigger: {
    on: { kind: "host-event", event: "go" },
    run: { kind: "steps", steps: [{ id: "s1", tool: "notify" }] },
  },
  // Authority fields that are not part of AppDocument at all — must not survive.
  grants: [{ tool: "host_pay" }],
  appId: "app_VICTIM",
});

const newRuntime = () => createApps({
  store: memoryStore(),
  guard: guardFixture(),
  tools: { async descriptors() { return []; }, async execute() { return { status: "error", error: { code: "not-found", message: "x" } }; } },
  sandbox: fakeSandbox(),
  catalog: [],
  model: scriptedLanguageModel("{}"),
});

describe("interchange authority forgery", () => {
  it("mints a fresh id, drops forged lineage/server, and imports DISARMED", async () => {
    const store = memoryStore();
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools: { async descriptors() { return []; }, async execute() { return { status: "error", error: { code: "not-found", message: "x" } }; } },
      sandbox: fakeSandbox(),
      catalog: [],
      model: scriptedLanguageModel("{}"),
    });

    const imported = await runtime.importApp(forgedDocument(), context("user_attacker"));

    // Fresh minted id — the attacker-chosen "app_VICTIM" is never trusted.
    expect(imported.id).not.toBe("app_VICTIM");
    expect(imported.id).toMatch(/^app_/);
    // Fabricated lineage dropped.
    expect(imported.forkedFrom).toBeUndefined();
    // The pre-owned snapshot ref is NOT trusted (object import provisions no directory).
    expect(imported.server).not.toBe("e2b:snap_evil");
    // Non-AppDocument authority fields never survive.
    expect(imported).not.toHaveProperty("grants");
    expect(imported).not.toHaveProperty("appId");

    // Persisted row is DISABLED — the smuggled trigger is not armed on import.
    const row = await store.records("vendo_apps").get(imported.id);
    expect((row?.data as { enabled: boolean }).enabled).toBe(false);
    expect((row?.data as { subject: string }).subject).toBe("user_attacker");
  });

  it("gives a fresh, distinct id every time the same forged doc is imported", async () => {
    const runtime = newRuntime();
    const first = await runtime.importApp(forgedDocument(), context("user_attacker"));
    const second = await runtime.importApp(forgedDocument(), context("user_attacker"));
    expect(first.id).not.toBe(second.id);
    expect(first.id).not.toBe("app_VICTIM");
    expect(second.id).not.toBe("app_VICTIM");
  });

  it("applies the same fresh-id guarantee to tampered .vendoapp archive bytes", async () => {
    const runtime = newRuntime();
    // A hand-built archive whose app.json smuggles id/server/forkedFrom.
    const archive = zipSync({
      "app.json": encoder.encode(JSON.stringify({
        format: VENDO_APP_FORMAT,
        id: "app_VICTIM",
        name: "Archive Forgery",
        ui: "tree",
        tree: {
          formatVersion: "vendo-genui/v2",
          root: "root",
          nodes: [{ id: "root", component: "Text", props: { text: "hi" } }],
        },
        storage: {},
        server: "e2b:snap_evil",
        forkedFrom: "app_owner",
      })),
    });

    const imported = await runtime.importApp(archive, context("user_attacker"));
    expect(imported.id).not.toBe("app_VICTIM");
    expect(imported.id).toMatch(/^app_/);
    expect(imported.forkedFrom).toBeUndefined();
    expect(imported.server).not.toBe("e2b:snap_evil");
  });
});
