/**
 * AN EXPIRY IS NOT A REFUSAL.
 *
 * Live 2026-08-18 on production Maple, automation atm_d50cd48e: 33 arming asks
 * were created at 11:26 and all 33 were denied at 12:27 — createdAt plus exactly
 * the parked-call TTL — and the record flipped to armed=false at 12:27:37. Not one
 * human decision was ever recorded. The person's automation turned itself off an
 * hour after they set it up, silently, because the guard's expiry sweep denies as
 * `"system"` and the automations decision subscriber read any deny as a person's
 * "no".
 *
 * The provenance is the whole of the bug and it is why this test drives the REAL
 * guard: `onApprovalDecision` carries only (id, approved), so `deniedBy` exists
 * nowhere except on the persisted approval row. A double that reported its own
 * denials could agree with the engine about a field the guard is the only writer
 * of — the producer and the consumer have to be the real ones, over one real
 * store, for this to prove anything.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { automationsInternals } from "@vendoai/automations";
import type {
  AutomationId,
  Principal,
  RunContext,
  ToolDescriptor,
  ToolRegistry,
} from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo, type Vendo } from "../src/server.js";

const principal: Principal = { kind: "user", subject: "user_ttl_sweep" };
const ctx: RunContext = { principal, venue: "chat", presence: "present", sessionId: "session_ttl_sweep" };

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

/** An automation with arming asks still OUTSTANDING — the state the live record
 *  was in when the sweep reached it. The policy asks about the one tool, and
 *  `enable` is called with no authoring call, so nothing is consented and every
 *  power is captured as a pending ask (the leftover path). */
async function armedWithPendingAsks(): Promise<{ vendo: Vendo; id: AutomationId; askIds: string[] }> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-ttl-sweep-"));
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
  const record = await automationsInternals(vendo.automations).create({
    owner: principal,
    when: { event: "go" },
    task: { kind: "steps", steps: [{ id: "read", tool: readAccounts.name }] },
    authoredBy: "chat",
    armed: false,
  }, ctx);
  const armed = await vendo.automations.enable(record.id, ctx);
  expect(armed.enabled).toBe(true);
  expect(armed.missing.length).toBeGreaterThan(0);
  expect(await vendo.automations.get(record.id, ctx)).toMatchObject({ armed: true });
  return { vendo, id: record.id, askIds: armed.missing.map((ask) => ask.id) };
}

describe.sequential("CHECK: the TTL sweep never disarms an automation nobody said no to", () => {
  it("leaves the record ARMED when the hour-long sweep expires its arming asks", async () => {
    const { vendo, id, askIds } = await armedWithPendingAsks();

    // The sweep, exactly as compose-sweep drives it in production: every pending
    // approval older than the TTL, denied as `"system"`, as its own principal.
    // Feature-detected the same way `compose-sweep.ts` does — a guard without it
    // never sweeps, so there would be nothing here to prove.
    const sweep = vendo.guard.sweepExpiredApprovals;
    expect(sweep).toBeDefined();
    const swept = await sweep!.call(vendo.guard, 60 * 60_000, Date.now() + 2 * 60 * 60_000);
    expect(swept).toBe(askIds.length);

    // THE POINT. The person set this up and answered nothing yet; an hour passing
    // is not them saying no, so the automation they armed is still armed.
    expect(await vendo.automations.get(id, ctx)).toMatchObject({ armed: true });

    // And the asks really were settled — the sweep's job is to stop the queue
    // accreting forever, which it still does. What is gone is only the silent
    // disarm: the record stays on, holding no grant, so its next firing meets the
    // permission it does not have and asks again there (05 §6, J5) instead of the
    // automation having quietly ceased to exist.
    const pending = await vendo.guard.approvals.pending(principal);
    expect(pending.filter((ask) => askIds.includes(ask.id))).toEqual([]);
  });

  it("still disarms on a real person's NO, so the channel's receipt stays true", async () => {
    const { vendo, id, askIds } = await armedWithPendingAsks();

    // The mirror, and the reason this cannot be fixed by ignoring denials
    // wholesale: a bare no over text means "turn it off", and the channel answers
    // "Okay — I turned it off." That sentence has to remain true.
    await vendo.guard.approvals.decide([...askIds], { approve: false }, principal);

    expect(await vendo.automations.get(id, ctx)).toMatchObject({ armed: false });
    expect(await vendo.guard.grants.list(principal)).toEqual([]);
  });
});
