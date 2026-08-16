/**
 * ADVERSARIAL CHECK on the seam the change created: automations no longer
 * WRITES the standing grant a consent moment mints — it hands the input to
 * `guard.mintGrant` and the guard writes it. Producer and consumer are now two
 * different blocks, so this drives the REAL guard and the REAL automations
 * engine over ONE real store, and reads the grant back through the read path
 * that actually gates a firing (`enable` reporting nothing missing). The
 * package-level test for this uses a GuardDouble whose `mintGrant` writes
 * nothing at all, so it cannot see a producer and consumer disagreeing.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VENDO_APP_FORMAT,
  type AppDocument,
  type Principal,
  type RunContext,
  type ToolDescriptor,
  type ToolRegistry,
} from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo, type Vendo } from "../src/server.js";

const principal: Principal = { kind: "user", subject: "user_seam" };
const ctx: RunContext = { principal, venue: "chat", presence: "present", sessionId: "session_seam" };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const readAccounts: ToolDescriptor = {
  name: "host_read_accounts",
  description: "Read the accounts",
  inputSchema: { type: "object" },
  risk: "read",
};

const host: ToolRegistry = {
  async descriptors() {
    return [readAccounts];
  },
  async execute() {
    return { status: "ok", output: {} };
  },
};

const doc: AppDocument = {
  format: VENDO_APP_FORMAT,
  id: "app_seam",
  name: "Nightly sweep",
  triggers: [{
    id: "main",
    on: { kind: "host-event", event: "go" },
    run: { kind: "steps", steps: [{ id: "read", tool: readAccounts.name }] },
  }],
};

async function setup(): Promise<Vendo> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-grant-seam-"));
  const store: VendoStore = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const vendo = createVendo({
    models: { default: {} as LanguageModel },
    principal: async () => principal,
    store,
    guard: { policy: { rules: [{ match: { risk: "read" }, action: "ask" }] } },
  });
  vendo.actions.add(host);
  await store.ensureSchema();
  await store.records("vendo_apps").put({
    id: doc.id,
    data: { subject: principal.subject, enabled: false, doc },
    refs: { subject: principal.subject },
  });
  return vendo;
}

describe.sequential("CHECK: the grant automations asks the GUARD to mint is the grant automations reads back", () => {
  it("arms the trigger — enable, decide through the real guard, enable again with nothing missing", async () => {
    const vendo = await setup();

    const first = await vendo.automations.enable(doc.id, "main", ctx);
    expect(first.missing.length).toBeGreaterThan(0);

    await vendo.guard.approvals.decide(first.missing.map((ask) => ask.id), { approve: true }, principal);

    // The consumer side: the same live-grant read every firing asks its three
    // authority questions from. A row the guard wrote somewhere automations
    // cannot see would leave this asking for consent forever.
    const again = await vendo.automations.enable(doc.id, "main", ctx);
    expect(again.missing).toEqual([]);
    expect(again.enabled).toBe(true);
  });

  it("writes ONE grant row, scoped to the subject, the app and the trigger the person armed", async () => {
    const vendo = await setup();
    const first = await vendo.automations.enable(doc.id, "main", ctx);
    await vendo.guard.approvals.decide(first.missing.map((ask) => ask.id), { approve: true }, principal);

    const grants = await vendo.guard.grants.list(principal);

    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      subject: principal.subject,
      tool: readAccounts.name,
      appId: doc.id,
      triggerId: "main",
      source: "automation",
      duration: "standing",
      scope: { kind: "tool" },
    });
  });
});
