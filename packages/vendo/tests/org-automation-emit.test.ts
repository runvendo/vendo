import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { automationsInternals } from "@vendoai/automations";
import type { Membership, Principal, RunContext, ToolRegistry } from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVendo, type Vendo } from "../src/server.js";

/**
 * ORCHESTRATOR RULING 2026-08-01 (handoff #5) — a member's event fires the
 * ORG's automations. Over the real composition this pins `compose-automations`'
 * `memberships:` line, which nothing else covers: without it the engine asserts
 * no orgs for the emitter and an org-owned record stays unreachable forever.
 */

const ORG = "maple";
const kim: Principal = { kind: "user", subject: "kim" };
const omar: Principal = { kind: "user", subject: "omar" };

const memberships: Record<string, Membership[]> = {
  kim: [{ org: ORG, display: "Maple Bank", teams: ["support"] }],
  omar: [{ org: ORG, display: "Maple Bank", teams: ["support"] }],
};

const READ_TOOL = "host_readInvoices";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

interface Booted {
  vendo: Vendo;
  store: VendoStore;
}

async function boot(): Promise<Booted> {
  const root = await mkdtemp(join(tmpdir(), "vendo-org-automation-"));
  const store = createStore({ dataDir: join(root, "data") });
  cleanups.push(async () => {
    await store.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const vendo = createVendo({
    store,
    auth: {
      principal: async () => kim,
      memberships: async (principal) => memberships[principal.subject] ?? [],
    },
  });
  const tools: ToolRegistry = {
    async descriptors() {
      return [{ name: READ_TOOL, description: "Read the invoices", inputSchema: { type: "object" }, risk: "read" }];
    },
    async execute() { return { status: "ok", output: { invoices: [] } }; },
  };
  vendo.actions.add(tools);
  await store.ensureSchema();
  return { vendo, store };
}

/** A direct-call ctx asserts the caller's orgs exactly as the wire's own
 *  resolver does (§9.1) — memberships ride the ctx and are read from nowhere
 *  else, so a hand-built ctx that omits them is a caller with no orgs. */
const ctxOf = (who: Principal): RunContext => ({
  principal: who,
  venue: "automation",
  presence: "away",
  sessionId: `s_${who.subject}`,
  memberships: memberships[who.subject] ?? [],
});

describe("vendo.emit fires an ORG-owned automation for a member", () => {
  it("fires for a member, as the automation's own owner, and fires nothing for a non-member", async () => {
    const booted = await boot();
    const record = await automationsInternals(booted.vendo.automations).create({
      owner: { kind: "org", subject: ORG },
      when: { event: "invoice.paid" },
      task: { kind: "steps", steps: [{ id: "read", tool: READ_TOOL }] },
      authoredBy: "chat",
    }, ctxOf(kim));

    // A member of the same org emits the event: the org's automation fires.
    const fired = await booted.vendo.emit("invoice.paid", {}, omar);
    expect(fired).toHaveLength(1);
    // It got PAST the fire-time gate and into its first step, where the real
    // guard asks for a standing grant nobody has approved. There is no waiting
    // state away: the run ends LOUDLY, naming the tool whose permission it
    // needed, and `runs.rerun` is how it runs again once someone allows it.
    expect(await booted.vendo.automations.runs.get(fired[0]!, ctxOf(kim))).toMatchObject({
      automationId: record.id,
      status: "error",
      error: { code: "needs-permission", tool: READ_TOOL },
    });

    // Somebody the host asserts no membership for emits the very same event and
    // reaches nothing at all.
    const stranger: Principal = { kind: "user", subject: "stranger" };
    expect(await booted.vendo.emit("invoice.paid", {}, stranger)).toEqual([]);
  });
});
